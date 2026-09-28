// Isolated browser -> real merge endpoint -> real reference store + audio probe.
// No model downloads, synthesis, or user data. Run: node tests/reference-merge-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '../..');
const data = mkdtempSync(resolve(tmpdir(), 'voicestudio-reference-smoke-'));
const apiPort = Number(process.env.MERGE_SMOKE_API_PORT || 3914);
const uiPort = Number(process.env.MERGE_SMOKE_UI_PORT || 3913);
process.env.OMNIVOICE_PORT = String(apiPort);
const { default: config } = await import('./renderer-smoke.vite.config.mjs');
const python =
  process.env.MERGE_SMOKE_PYTHON ||
  resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const backend = spawn(
  python,
  [
    '-c',
    [
      'from fastapi import FastAPI',
      'from api.routers.tools import router',
      'import uvicorn',
      'app = FastAPI()',
      'app.include_router(router)',
      `uvicorn.run(app, host="127.0.0.1", port=${apiPort})`,
    ].join('; '),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: resolve(root, 'backend'),
      OMNIVOICE_DATA_DIR: data,
      HF_HUB_OFFLINE: '1',
      HF_HUB_CACHE: resolve(data, 'hf-empty'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let backendLog = '';
backend.stdout.on('data', (chunk) => {
  backendLog += chunk;
});
backend.stderr.on('data', (chunk) => {
  backendLog += chunk;
});
backend.on('error', (error) => {
  backendLog += error.message;
});
let server;
let browser;

function wav(value) {
  const samples = 24000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, 44 + i * 2);
  return buffer;
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${apiPort}/openapi.json`)).ok;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, backendLog);
  server = await createServer({
    ...config,
    configFile: false,
    server: { ...config.server, port: uiPort },
    plugins: [
      ...config.plugins,
      {
        name: 'reference-merge-fixture',
        configureServer(vite) {
          vite.middlewares.use('/reference-merge-smoke', async (_req, res, next) => {
            try {
              const fixture = resolve(
                import.meta.dirname,
                'reference-merge-fixture.tsx',
              ).replaceAll('\\', '/');
              const html = await vite.transformIndexHtml(
                '/reference-merge-smoke',
                `<html><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
              );
              res.setHeader('Content-Type', 'text/html');
              res.end(html);
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://localhost:${uiPort}/reference-merge-smoke`);
  const input = page.locator('input[type=file]');
  await input.waitFor({ state: 'attached' });
  const response = page.waitForResponse((r) => r.url().endsWith('/api/tools/merge-audio'));
  await input.setInputFiles(
    Array.from({ length: 5 }, (_, i) => ({
      name: `${i}.wav`,
      mimeType: 'audio/wav',
      buffer: wav(1000 * (i + 1)),
    })),
  );
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() =>
    document.querySelector('#result')?.textContent.includes('merged-reference.wav'),
  );
  const result = JSON.parse(await page.locator('#result').textContent());
  assert.deepEqual(result, { name: 'merged-reference.wav', type: 'audio/wav', duration: 5 });
  await page.locator('audio').evaluate((audio) => audio.play());
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0);
  await input.setInputFiles({ name: 'single.wav', mimeType: 'audio/wav', buffer: wav(1000) });
  await page.waitForFunction(() =>
    document.querySelector('#result')?.textContent.includes('single.wav'),
  );
  const failed = page.waitForResponse((r) => r.url().endsWith('/api/tools/merge-audio'));
  await input.setInputFiles([
    { name: 'good.wav', mimeType: 'audio/wav', buffer: wav(1000) },
    { name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') },
  ]);
  assert.equal((await failed).status(), 422);
  await page.getByText('One or more files could not be read as audio.').waitFor();
  assert.equal(JSON.parse(await page.locator('#result').textContent()).name, 'single.wav');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: five real clips -> merged WAV -> clone reference store -> playback; single-file and failed-merge preservation.',
  );
} finally {
  await browser?.close();
  await server?.close();
  backend.kill();
  if (backend.exitCode === null)
    await Promise.race([new Promise((resolve) => backend.once('exit', resolve)), delay(5000)]);
  if (backend.exitCode === null) backend.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true });
}
