import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  probes: new Map<string, (seconds: number) => void>(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({ apiFetch: mock.fetch, describeError: String }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: mock.toastError, warning: mock.toastWarning } }));
vi.mock('@/hooks/use-engines', () => ({ useEngines: () => ({ activeTts: null }) }));
vi.mock('@/lib/audio/probe', () => ({
  probeAudioDuration: (file: File) =>
    new Promise<number>((resolve) => mock.probes.set(file.name, resolve)),
}));
vi.mock('@/lib/store/reference', () => ({ setReferenceFile: vi.fn() }));
vi.mock('@/hooks/use-recording', () => ({ useRecording: vi.fn() }));
vi.mock('@/components/recording-inputs', () => ({ RecordingInputs: () => null }));
import { ReferenceSourcePicker, UploadZone } from './reference-input';
import { useRecording } from '@/hooks/use-recording';

afterEach(() => {
  cleanup();
  mock.probes.clear();
  vi.clearAllMocks();
  mock.fetch.mockReset();
});

const clip = (name: string) => new File(['audio'], name, { type: 'audio/wav' });

it('merges dropped clips, and reports failures without accepting a partial reference', async () => {
  mock.fetch.mockRejectedValue(new Error('Merge failed'));
  const onAccept = vi.fn();
  const view = render(<UploadZone onAccept={onAccept} />);
  fireEvent.drop(view.getByText('clone.drop_audio'), {
    dataTransfer: { files: [clip('a.wav'), clip('b.wav')] },
  });
  await vi.waitFor(() => expect(mock.toastError).toHaveBeenCalledWith('Error: Merge failed'));
  expect(onAccept).not.toHaveBeenCalled();
  expect(mock.probes.size).toBe(0);
});

it.each(['invalid', 'too-many'])('rejects %s selections without sending a merge', async (kind) => {
  const onAccept = vi.fn();
  const { container } = render(<UploadZone onAccept={onAccept} />);
  const files =
    kind === 'invalid'
      ? [clip('a.wav'), new File(['text'], 'bad.txt', { type: 'text/plain' })]
      : Array.from({ length: 21 }, (_, i) => clip(`${i}.wav`));
  fireEvent.change(container.querySelector('input')!, { target: { files } });
  expect(mock.toastError).toHaveBeenCalledOnce();
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(onAccept).not.toHaveBeenCalled();
});

it('rejects a merged reference above the existing combined duration limit', async () => {
  mock.fetch.mockResolvedValue({ blob: async () => new Blob(['merged']) });
  const onAccept = vi.fn();
  const { container } = render(<UploadZone onAccept={onAccept} />);
  fireEvent.change(container.querySelector('input')!, {
    target: { files: [clip('a.wav'), clip('b.wav')] },
  });
  await vi.waitFor(() => expect(mock.probes.has('merged-reference.wav')).toBe(true));
  mock.probes.get('merged-reference.wav')!(76);
  await vi.waitFor(() => expect(mock.toastError).toHaveBeenCalledWith('tts_errors.too_long'));
  expect(onAccept).not.toHaveBeenCalled();
});

it('discards a slow merge after a newer recording is accepted', async () => {
  let resolveMerge!: (response: unknown) => void;
  mock.fetch.mockReturnValue(
    new Promise((resolve) => {
      resolveMerge = resolve;
    }),
  );
  const record = mockRecorder();
  const onAccept = vi.fn();
  const { container } = render(<ReferenceSourcePicker onAccept={onAccept} />);
  fireEvent.change(container.querySelector('input')!, {
    target: { files: [clip('a.wav'), clip('b.wav')] },
  });
  record(clip('new.wav'));
  mock.probes.get('new.wav')!(5);
  await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
  resolveMerge({ blob: async () => new Blob(['old']) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mock.probes.has('merged-reference.wav')).toBe(false);
  expect(onAccept).toHaveBeenCalledOnce();
});

it('aborts a merge when the picker unmounts', async () => {
  mock.fetch.mockReturnValue(new Promise(() => {}));
  const { container, unmount } = render(<UploadZone onAccept={vi.fn()} />);
  fireEvent.change(container.querySelector('input')!, {
    target: { files: [clip('a.wav'), clip('b.wav')] },
  });
  const signal = mock.fetch.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
});

it('merges all selected clips in order and accepts the resulting WAV', async () => {
  mock.fetch.mockResolvedValue({ blob: async () => new Blob(['merged']) });
  const onAccept = vi.fn();
  const { container } = render(<UploadZone onAccept={onAccept} />);
  const input = container.querySelector('input')!;
  expect(input.multiple).toBe(true);
  const files = Array.from({ length: 5 }, (_, i) => clip(`${i}.wav`));
  fireEvent.change(input, { target: { files } });
  await vi.waitFor(() => expect(mock.probes.has('merged-reference.wav')).toBe(true));
  const [path, request] = mock.fetch.mock.calls[0];
  expect(path).toBe('/tools/merge-audio');
  expect(request.method).toBe('POST');
  expect(request.body.getAll('files').map((file: File) => file.name)).toEqual(
    files.map((f) => f.name),
  );
  expect(onAccept).not.toHaveBeenCalled();
  mock.probes.get('merged-reference.wav')!(12);
  await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
  expect(onAccept.mock.calls[0][0].name).toBe('merged-reference.wav');
  expect(onAccept.mock.calls[0][0].type).toBe('audio/wav');
  expect(onAccept.mock.calls[0][1]).toBe(12);
});

it('keeps the latest pick when an earlier clip finishes probing last', async () => {
  const onAccept = vi.fn();
  const { container } = render(<UploadZone onAccept={onAccept} />);
  const input = container.querySelector('input[type="file"]')!;

  fireEvent.change(input, { target: { files: [clip('first.wav')] } });
  fireEvent.change(input, { target: { files: [clip('second.wav')] } });
  mock.probes.get('second.wav')!(5);
  await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
  mock.probes.get('first.wav')!(90);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onAccept).toHaveBeenCalledOnce();
  expect(onAccept.mock.calls[0][0].name).toBe('second.wav');
  // The stale clip's too-long error is not shown for the clip the user kept.
  expect(mock.toastError).not.toHaveBeenCalled();
  expect(mock.toastWarning).not.toHaveBeenCalled();
});

it('shows no trim toast for an accepted long clip; the usage note covers it', async () => {
  const onAccept = vi.fn();
  const { container } = render(<UploadZone onAccept={onAccept} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [clip('long.wav')] },
  });
  mock.probes.get('long.wav')!(40);
  await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
  expect(mock.toastWarning).not.toHaveBeenCalled();
  expect(mock.toastError).not.toHaveBeenCalled();
});

it('shows the drop zone and the record button together, with no mode toggle', () => {
  vi.mocked(useRecording).mockReturnValue({
    level: 0,
    seconds: 0,
    isStarting: false,
    isCleaning: false,
    isRecording: false,
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as ReturnType<typeof useRecording>);
  const view = render(<ReferenceSourcePicker />);
  expect(view.getByText('clone.drop_audio')).toBeTruthy();
  expect(view.getByRole('button', { name: 'clone.record' })).toBeTruthy();
  expect(view.queryByRole('tablist')).toBeNull();
});

function mockRecorder() {
  let finish: (file: File) => void = () => {};
  vi.mocked(useRecording).mockImplementation(((onDone: (file: File) => void) => {
    finish = onDone;
    return {
      level: 0,
      seconds: 0,
      isStarting: false,
      isCleaning: false,
      isRecording: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
  }) as unknown as typeof useRecording);
  return (file: File) => finish(file);
}

it('never lets a slow upload probe replace a newer recording', async () => {
  const record = mockRecorder();
  const onAccept = vi.fn();
  const { container } = render(<ReferenceSourcePicker onAccept={onAccept} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [clip('upload.wav')] },
  });
  record(clip('recording.wav'));
  mock.probes.get('recording.wav')!(6);
  await vi.waitFor(() => expect(onAccept).toHaveBeenCalledOnce());
  mock.probes.get('upload.wav')!(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onAccept).toHaveBeenCalledOnce();
  expect(onAccept.mock.calls[0][0].name).toBe('recording.wav');
});

it('drops a probe that finishes after the picker closes', async () => {
  mockRecorder();
  const onAccept = vi.fn();
  const { container, unmount } = render(<ReferenceSourcePicker onAccept={onAccept} />);
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [clip('late.wav')] },
  });
  unmount();
  mock.probes.get('late.wav')!(5);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onAccept).not.toHaveBeenCalled();
});
