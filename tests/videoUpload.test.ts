// Sequencing a video's re-encode attempts: failures fall back or classify, aborts always win, and refusals step down.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYTES_PER_MB } from '@shared/units';
import type { EncodeQuality } from '@shared/videoEncode';
import { VideoUploadError, prepareVideoUpload, type EncodeAt, type EncodeAttempt } from '@shared/videoUpload';

const LIMIT = 10 * BYTES_PER_MB;
const video = (bytes: number): File => new File([new Uint8Array(bytes)], 'clip.mov', { type: 'video/quicktime' });
const encoded = (bytes: number): EncodeAttempt => ({ kind: 'encoded', file: new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' }) });

/** An encoder answering per quality, recording the qualities it was asked for. */
function encoder(answers: Partial<Record<EncodeQuality, () => Promise<EncodeAttempt>>>): EncodeAt & { asked: EncodeQuality[] } {
  const asked: EncodeQuality[] = [];
  const at = async (_file: File, quality: EncodeQuality) => {
    asked.push(quality);
    const answer = answers[quality];
    return answer ? answer() : { kind: 'unsupported' as const };
  };
  return Object.assign(at, { asked });
}

afterEach(() => vi.restoreAllMocks());

describe('prepareVideoUpload', () => {
  it('passes non-video files through without encoding', async () => {
    const enc = encoder({});
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(await prepareVideoUpload(text, 'standard', { limitBytes: 0 }, enc)).toBe(text);
    expect(enc.asked).toEqual([]);
  });

  it('treats a failure while preparing (a truncated header) as unsupported: the original if it fits, else a classified error', async () => {
    // Regression: only the conversion was guarded, so a RangeError from reading the input escaped unclassified.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = encoder({ standard: () => Promise.reject(new RangeError('Offset is outside the bounds of the DataView')) });
    const fits = video(LIMIT);
    expect(await prepareVideoUpload(fits, 'standard', { limitBytes: LIMIT }, broken)).toBe(fits);
    const over = prepareVideoUpload(video(LIMIT + 1), 'standard', { limitBytes: LIMIT }, broken);
    await expect(over).rejects.toBeInstanceOf(VideoUploadError);
    await expect(over).rejects.toMatchObject({ reason: 'unsupported' });
  });

  it('steps down to Data Saver when Standard is refused', async () => {
    // Regression: an unsupported Standard attempt (1280×720 refused, 852×480 accepted) failed without trying Data Saver.
    const enc = encoder({ dataSaver: () => Promise.resolve(encoded(LIMIT - 1)) });
    const result = await prepareVideoUpload(video(3 * LIMIT), 'standard', { limitBytes: LIMIT }, enc);
    expect(result.name).toBe('clip.mp4');
    expect(enc.asked).toEqual(['standard', 'dataSaver']);
  });

  it('tries Data Saver after a refused Standard even when the original fits', async () => {
    // Regression: a fitting original returned before the step down, so Data Saver was never tried.
    const enc = encoder({ dataSaver: () => Promise.resolve(encoded(3000)) });
    const result = await prepareVideoUpload(video(9000), 'standard', { limitBytes: 10_000 }, enc);
    expect(result.size).toBe(3000);
    expect(enc.asked).toEqual(['standard', 'dataSaver']);
  });

  it('keeps a fitting original when the re-encode saves less than MIN_SAVINGS', async () => {
    // Regression: a 9,999-byte encode replaced a 10,000-byte original.
    const original = video(10_000);
    const enc = encoder({ standard: () => Promise.resolve(encoded(9999)) });
    expect(await prepareVideoUpload(original, 'standard', { limitBytes: LIMIT }, enc)).toBe(original);
  });

  it('steps down when Standard is still over the limit, and fails as too large when Data Saver is too', async () => {
    const enc = encoder({ standard: () => Promise.resolve(encoded(2 * LIMIT)), dataSaver: () => Promise.resolve(encoded(LIMIT + 1)) });
    await expect(prepareVideoUpload(video(3 * LIMIT), 'best', { limitBytes: LIMIT }, enc)).rejects.toMatchObject({ reason: 'tooLarge' });
    expect(enc.asked).toEqual(['standard', 'dataSaver']);
  });

  it('never resolves once aborted, even when the encode finishes after the abort', async () => {
    // Regression: no abort check followed the encode, so a cancelled run could still resolve with a file.
    const ac = new AbortController();
    const reason = new Error('cancelled');
    const enc = encoder({
      standard: () => {
        ac.abort(reason);
        return Promise.resolve(encoded(1));
      },
    });
    await expect(prepareVideoUpload(video(LIMIT), 'standard', { limitBytes: LIMIT, signal: ac.signal }, enc)).rejects.toBe(reason);
  });

  it('rethrows the abort reason, not a fallback, when the encoder fails because of the abort', async () => {
    const ac = new AbortController();
    const reason = new Error('cancelled');
    const enc = encoder({
      standard: () => {
        ac.abort(reason);
        return Promise.reject(new Error('Input disposed'));
      },
    });
    await expect(prepareVideoUpload(video(LIMIT), 'standard', { limitBytes: LIMIT, signal: ac.signal }, enc)).rejects.toBe(reason);
  });

  it('does not start when already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const enc = encoder({});
    await expect(prepareVideoUpload(video(LIMIT), 'standard', { limitBytes: LIMIT, signal: ac.signal }, enc)).rejects.toThrow('cancelled');
    expect(enc.asked).toEqual([]);
  });
});
