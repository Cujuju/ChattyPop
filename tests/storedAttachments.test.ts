import { File } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_BYTES } from '@shared/compose';
import { ARCHIVE_ENCODE_PROGRESS_SHARE } from '@shared/attachmentReplacement';
import { FREE_ATTACHMENTS_MAX } from '@shared/types/attachmentStore';
import { setMediaRoot } from '@shared/media';

const env = vi.hoisted(() => ({
  local: true, fetch: vi.fn(), image: vi.fn(), video: vi.fn(),
  begin: vi.fn(), chunk: vi.fn(), finish: vi.fn(), abort: vi.fn(), free: vi.fn(),
}));
vi.mock('../src/renderer/src/api', () => ({ api: {
  media: { beginReplacement: env.begin, replacementChunk: env.chunk, finishReplacement: env.finish, abortReplacement: env.abort },
  core: { freeAttachments: env.free },
} }));
vi.mock('../src/renderer/src/state/ui', () => ({ get onServerScreen() { return env.local; } }));
vi.mock('../src/renderer/src/state/videoEncode', () => ({ encodeForArchive: env.video }));
vi.mock('../src/renderer/src/state/imageEncode', () => ({ encodeImageForArchive: env.image }));

const STORE_MODULE = '../src/renderer/src/state/storedAttachments';
const ORIGINAL_BYTES = 300;
const ENCODED_BYTES = 100;
const attachment = { id: '300000000000000001', sha256: 'a'.repeat(64), filename: 'picture.png', storedExt: null,
  contentType: 'image/png', status: 'stored', animated: false, compressed: false };
type Outcome = { kind: 'compressed'; savedBytes: number } | { kind: 'skipped'; reason: string };
interface Store {
  canCompressHere: boolean;
  compressStored(a: typeof attachment, opts?: { signal?: AbortSignal; onProgress?(fraction: number): void }): Promise<Outcome>;
  freeStored(ids: readonly string[]): Promise<{ freed: number; bytes: number }>;
}
const load = async (): Promise<Store> => await import(STORE_MODULE);

beforeEach(() => {
  vi.resetModules();
  env.local = true;
  env.fetch.mockReset().mockImplementation(async () => new Response(new Uint8Array(ORIGINAL_BYTES)));
  env.image.mockReset().mockResolvedValue({ kind: 'encoded', file: new Blob([new Uint8Array(ENCODED_BYTES)], { type: 'image/webp' }) });
  env.video.mockReset().mockImplementation(async (_file, opts) => {
    opts.onProgress?.(0.5);
    return { kind: 'encoded', file: new Blob([new Uint8Array(ENCODED_BYTES)]) };
  });
  env.begin.mockReset().mockResolvedValue({ token: 'replacement-token' });
  env.chunk.mockReset().mockResolvedValue(undefined);
  env.finish.mockReset().mockResolvedValue({ savedBytes: ORIGINAL_BYTES - ENCODED_BYTES });
  env.abort.mockReset().mockResolvedValue(undefined);
  env.free.mockReset().mockImplementation(async (ids: string[]) => ({ freed: ids.length, bytes: ids.length }));
  vi.stubGlobal('fetch', env.fetch);
  vi.stubGlobal('File', File);
  setMediaRoot('cp-media://');
});
afterEach(() => vi.unstubAllGlobals());

describe('stored attachment renderer store', () => {
  it('reads the local original, encodes an image and commits its smaller replacement', async () => {
    const store = await load();
    await expect(store.compressStored(attachment)).resolves.toEqual({ kind: 'compressed', savedBytes: ORIGINAL_BYTES - ENCODED_BYTES });
    expect(env.fetch).toHaveBeenCalledWith(`cp-media://attachment/${attachment.sha256}.png`, { signal: undefined });
    expect(env.image.mock.calls[0]![0].name).toBe(attachment.filename);
    expect(env.image.mock.calls[0]![0].type).toBe(attachment.contentType);
    expect(env.begin).toHaveBeenCalledWith(attachment.id, 'webp');
    expect(env.chunk).toHaveBeenCalledWith('replacement-token', 0, expect.any(Uint8Array));
    expect(env.finish).toHaveBeenCalledWith('replacement-token');
    expect(env.abort).not.toHaveBeenCalled();
  });

  it('streams bounded output slices and shares progress between video encoding and copying', async () => {
    const encodedBytes = UPLOAD_CHUNK_BYTES + ENCODED_BYTES;
    const originalBytes = encodedBytes * 2;
    env.fetch.mockImplementation(async () => new Response(new Uint8Array(originalBytes)));
    env.video.mockImplementation(async (_file, opts) => {
      opts.onProgress?.(0.5);
      return { kind: 'encoded', file: new Blob([new Uint8Array(encodedBytes)]) };
    });
    const progress: number[] = [];
    const store = await load();
    await store.compressStored({ ...attachment, filename: 'clip.mp4', contentType: 'video/mp4' }, { onProgress: (fraction) => progress.push(fraction) });
    expect(env.begin).toHaveBeenCalledWith(attachment.id, 'mp4');
    expect(env.chunk.mock.calls.map(([, offset, bytes]) => [offset, bytes.length])).toEqual([[0, UPLOAD_CHUNK_BYTES], [UPLOAD_CHUNK_BYTES, ENCODED_BYTES]]);
    expect(progress).toContain(ARCHIVE_ENCODE_PROGRESS_SHARE * 0.5);
    expect(progress.every((fraction, index) => fraction >= (progress[index - 1] ?? 0) && fraction <= 1)).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  it.each(['unsupported', 'not-smaller'] as const)('skips %s without starting disk replacement', async (reason) => {
    env.image.mockResolvedValue(reason === 'unsupported' ? { kind: 'unsupported' } : { kind: 'encoded', file: new Blob([new Uint8Array(ORIGINAL_BYTES)]) });
    await expect((await load()).compressStored(attachment)).resolves.toEqual({ kind: 'skipped', reason });
    expect(env.begin).not.toHaveBeenCalled();
  });

  it('serializes encoding and advances the queue after a failed operation', async () => {
    let active = 0;
    let peak = 0;
    env.image.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { kind: 'unsupported' };
    });
    env.fetch.mockRejectedValueOnce(new Error('Read failed'));
    const store = await load();
    const results = await Promise.allSettled([store.compressStored(attachment), store.compressStored(attachment), store.compressStored(attachment)]);
    expect(results[0]!.status).toBe('rejected');
    expect(results.slice(1).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(peak).toBe(1);
  });

  it('aborts the disk token and rejects with the signal reason after a chunk', async () => {
    const controller = new AbortController();
    const reason = new Error('Owner cancelled');
    env.chunk.mockImplementation(async () => controller.abort(reason));
    await expect((await load()).compressStored(attachment, { signal: controller.signal })).rejects.toBe(reason);
    expect(env.abort).toHaveBeenCalledWith('replacement-token');
    expect(env.finish).not.toHaveBeenCalled();
  });

  it('cancels a queued encode immediately without starting a second hardware encoder', async () => {
    let release!: (attempt: { kind: 'unsupported' }) => void;
    env.image.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const store = await load();
    const first = store.compressStored(attachment);
    await vi.waitFor(() => expect(env.image).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const reason = new Error('Cancelled in queue');
    const queued = store.compressStored(attachment, { signal: controller.signal });
    const refused = expect(queued).rejects.toBe(reason);
    controller.abort(reason);
    await refused;
    expect(env.image).toHaveBeenCalledOnce();
    release({ kind: 'unsupported' });
    await first;
  });

  it('aborts after a delayed begin resolves and surfaces core errors', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled while beginning');
    env.begin.mockImplementation(async () => { controller.abort(reason); return { token: 'replacement-token' }; });
    const store = await load();
    await expect(store.compressStored(attachment, { signal: controller.signal })).rejects.toBe(reason);
    expect(env.abort).toHaveBeenCalledWith('replacement-token');
    env.begin.mockResolvedValue({ token: 'replacement-token' });
    const coreError = new Error('Core refused');
    env.finish.mockRejectedValue(coreError);
    await expect(store.compressStored(attachment)).rejects.toBe(coreError);
  });

  it('refuses compression outside the local app window', async () => {
    env.local = false;
    const store = await load();
    expect(store.canCompressHere).toBe(false);
    await expect(store.compressStored(attachment)).rejects.toThrow('archive PC');
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('deduplicates deletion ids, batches by the core cap and sums results', async () => {
    const ids = Array.from({ length: FREE_ATTACHMENTS_MAX + 1 }, (_, index) => String(index));
    const store = await load();
    await expect(store.freeStored([...ids, ids[0]!])).resolves.toEqual({ freed: ids.length, bytes: ids.length });
    expect(env.free.mock.calls.map(([batch]) => batch.length)).toEqual([FREE_ATTACHMENTS_MAX, 1]);
    expect(env.free.mock.calls.flatMap(([batch]) => batch)).toEqual(ids);
    env.free.mockClear();
    await expect(store.freeStored([])).resolves.toEqual({ freed: 0, bytes: 0 });
    expect(env.free).not.toHaveBeenCalled();
  });
});
