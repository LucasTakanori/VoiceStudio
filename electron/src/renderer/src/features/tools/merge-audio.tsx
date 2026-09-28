import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  ListPlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
import { getBridge } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { PipelineFailure } from '@/components/pipeline-failure';
import { WaveformPlayer } from '@/components/waveform-player';
import { apiFetch, describeError } from '@/lib/api/client';

const MAX_FILES = 20;

export function MergeAudio() {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [output, setOutput] = useState<Blob | null>(null);
  const [outputUrl, setOutputUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!output) {
      setOutputUrl('');
      return;
    }
    const url = URL.createObjectURL(output);
    setOutputUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [output]);

  const updateFiles = (next: File[]) => {
    setFiles(next);
    setOutput(null);
    setError('');
  };

  const moveFile = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    [next[index], next[target]] = [next[target]!, next[index]!];
    updateFiles(next);
  };

  const merge = async () => {
    if (busy || files.length < 2) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setOutput(null);
    try {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      const response = await apiFetch('/tools/merge-audio', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setOutput(await response.blob());
    } catch (cause) {
      if (!controller.signal.aborted) setError(describeError(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  const download = async () => {
    if (!outputUrl || !output) return;
    const bridge = getBridge();
    if (!bridge) {
      const link = document.createElement('a');
      link.href = outputUrl;
      link.download = 'merged-reference.wav';
      link.click();
      return;
    }
    setSaving(true);
    try {
      const saved = await bridge.files.saveData({
        data: new Uint8Array(await output.arrayBuffer()),
        suggestedName: 'merged-reference.wav',
      });
      if (!saved.canceled && saved.path) toast.success(t('clone.saved_to', { path: saved.path }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(t('clone.download_failed', { message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">{t('tools.merge_audio')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('tools.merge_audio_desc')}
        </p>
      </div>

      <div className="space-y-3">
        <input
          ref={input}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac,.webm"
          multiple
          className="sr-only"
          aria-label={t('tools.choose_audio_files')}
          disabled={busy}
          onChange={(event) => {
            const additions = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (!additions.length) return;
            const next = [...files, ...additions];
            if (next.length > MAX_FILES) {
              setError(t('tools.merge_too_many_files'));
              return;
            }
            updateFiles(next);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <ListPlusIcon />
          {t('tools.choose_audio_files')}
        </Button>

        <p className="text-sm text-muted-foreground">{t('tools.merge_order_hint')}</p>
        {files.length > 0 && (
          <ol className="space-y-2" aria-label={t('tools.merge_audio')}>
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
              >
                <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                  {index + 1}.
                </span>
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                  {file.name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t('tools.move_up')}: ${file.name}`}
                  disabled={busy || index === 0}
                  onClick={() => moveFile(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t('tools.move_down')}: ${file.name}`}
                  disabled={busy || index === files.length - 1}
                  onClick={() => moveFile(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t('tools.remove_file')}: ${file.name}`}
                  disabled={busy}
                  onClick={() => updateFiles(files.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <Button type="button" disabled={busy || files.length < 2} onClick={() => void merge()}>
        {t(busy ? 'common.loading' : 'tools.merge_files')}
      </Button>
      {error && <PipelineFailure fallback={error} onDismiss={() => setError('')} />}

      {outputUrl && (
        <section
          className="space-y-3 rounded-xl border border-border/50 p-4"
          aria-label={t('tools.merged_audio')}
        >
          <h3 className="text-sm font-medium">{t('tools.merged_audio')}</h3>
          <WaveformPlayer src={outputUrl} source="merged-reference" />
        <Button type="button" variant="outline" disabled={saving} onClick={() => void download()}>
            <DownloadIcon />
            {t('tools.download_merged')}
          </Button>
        </section>
      )}
    </div>
  );
}
