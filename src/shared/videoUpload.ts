// Sequences a video's re-encode attempts before upload: which quality, when to step down, which file goes up, and how
// failures and aborts surface. The encoder is injected; state/videoEncode.ts passes Mediabunny's.
import type { VideoQuality } from './chatSettings';
import { chooseUpload, encodeQualityFor, isVideoType, retryQuality, videoLimitMessage, type EncodeQuality, type VideoLimitReason } from './videoEncode';

export interface PrepareUploadOptions {
  /** The destination's upload limit, bytes. */
  limitBytes: number;
  signal?: AbortSignal;
  /** 0..1 per encode attempt; a step down starts again at 0. */
  onProgress?(fraction: number): void;
}

/** One encode attempt: the re-encoded file, skipped (not worth it), or impossible on this device. */
export type EncodeAttempt = { kind: 'encoded'; file: File } | { kind: 'skipped' } | { kind: 'unsupported' };
export type EncodeAt = (file: File, quality: EncodeQuality, opts: PrepareUploadOptions) => Promise<EncodeAttempt>;

/** A video that can't go up within the limit; `message` is written for the UI. */
export class VideoUploadError extends Error {
  constructor(readonly reason: VideoLimitReason, limitBytes: number) {
    super(videoLimitMessage(reason, limitBytes));
    this.name = 'VideoUploadError';
  }
}

/** The file to upload: non-video unchanged, else chooseUpload's pick, stepping down while none fits or the device refuses. */
export async function prepareVideoUpload(file: File, quality: VideoQuality, opts: PrepareUploadOptions, encodeAt: EncodeAt): Promise<File> {
  if (!isVideoType(file.type)) return file;
  const { signal, limitBytes } = opts;
  let target = encodeQualityFor(quality, file.size, limitBytes);
  while (target) {
    signal?.throwIfAborted();
    const attempt = await attemptEncode(encodeAt, file, target, opts);
    signal?.throwIfAborted();
    const result = attempt.kind === 'encoded' ? { kind: 'encoded' as const, bytes: attempt.file.size } : attempt;
    const choice = chooseUpload(file.size, result, limitBytes);
    const next = retryQuality(target, result, choice);
    if (next) {
      target = next;
      continue;
    }
    if ('send' in choice) return choice.send === 'encoded' && attempt.kind === 'encoded' ? attempt.file : file;
    throw new VideoUploadError(choice.fail, limitBytes);
  }
  return file;
}

/** Any failure but an abort means this device can't encode this file: a damaged header, a refused codec, an encoder error. */
async function attemptEncode(encodeAt: EncodeAt, file: File, quality: EncodeQuality, opts: PrepareUploadOptions): Promise<EncodeAttempt> {
  try {
    return await encodeAt(file, quality, opts);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    console.warn('[video encode]', err);
    return { kind: 'unsupported' };
  }
}
