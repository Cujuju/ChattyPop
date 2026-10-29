import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_CHUNK_BYTES } from '@shared/compose';
import { attachmentShard } from '@shared/media';
import type { MainCore } from '../src/main/coreClient';
import { PARTIAL_DOWNLOAD_PREFIX } from '../src/main/media/attachmentDownloader';
import { REPLACEMENT_IDLE_MS, StoreReplacements } from '../src/main/media/storeReplacements';

const ID = '300000000000000001';
const OTHER_ID = '300000000000000002';
const OLD_SHA = 'a'.repeat(64);
const ORIGINAL_BYTES = 100;
const BODY = Buffer.from('smaller');
const NEW_SHA = createHash('sha256').update(BODY).digest('hex');
const roots: string[] = [];
const stores: { store: StoreReplacements; tokens: string[] }[] = [];

function fixture(refused = false, size = ORIGINAL_BYTES) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-replacements-'));
  roots.push(dir);
  const call = vi.fn(async (method: string, arg: unknown) => {
    if (method === 'storedFile') return { id: arg, sha256: OLD_SHA, filename: 'original.png', storedExt: null,
      contentType: 'image/png', storedBytes: size, compressedAt: null };
    if (refused) throw new Error('Core refused replacement');
    return { savedBytes: size - BODY.length };
  });
  const store = new StoreReplacements(dir, { call } as unknown as Pick<MainCore, 'call'>);
  const tokens: string[] = [];
  stores.push({ store, tokens });
  const begin = async (id: unknown = ID, ext: unknown = 'webp') => {
    const { token } = await store.begin(id, ext);
    tokens.push(token);
    return token;
  };
  const dest = join(dir, attachmentShard(NEW_SHA), `${NEW_SHA}.webp`);
  return { dir, store, begin, dest, call };
}

afterEach(async () => {
  for (const { store, tokens } of stores.splice(0)) for (const token of tokens) await store.abort(token);
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stored attachment replacements', () => {
  it('writes ordered pieces, moves by hash and tells core which rows to repoint', async () => {
    const f = fixture();
    const token = await f.begin();
    const split = Math.floor(BODY.length / 2);
    await f.store.chunk(token, 0, BODY.subarray(0, split));
    await f.store.chunk(token, split, BODY.subarray(split));
    await expect(f.store.finish(token)).resolves.toEqual({ savedBytes: ORIGINAL_BYTES - BODY.length });
    expect(readFileSync(f.dest)).toEqual(BODY);
    expect(f.call).toHaveBeenLastCalledWith('attachmentRecompressed', {
      sha256: OLD_SHA, newSha256: NEW_SHA, storedExt: 'webp', bytes: BODY.length,
    });
    expect(readdirSync(f.dir).some((name) => name.startsWith(PARTIAL_DOWNLOAD_PREFIX))).toBe(false);
  });

  it('refuses out-of-order, duplicate and oversized pieces without corrupting the writer', async () => {
    const f = fixture();
    const token = await f.begin();
    await expect(f.store.chunk(token, BODY.length, BODY)).rejects.toThrow('out of order');
    await expect(f.store.chunk(token, 0, new Uint8Array(UPLOAD_CHUNK_BYTES + 1))).rejects.toThrow('Not a replacement piece');
    await expect(f.store.chunk(token, 0, 'bytes')).rejects.toThrow('Not a replacement piece');
    await f.store.chunk(token, 0, BODY);
    await expect(f.store.chunk(token, 0, BODY)).rejects.toThrow('out of order');
    await f.store.finish(token);
    expect(readFileSync(f.dest)).toEqual(BODY);
  });

  it.each([ORIGINAL_BYTES, ORIGINAL_BYTES + 1])('aborts and removes a %i-byte replacement that is not smaller', async (size) => {
    const f = fixture();
    const token = await f.begin();
    await expect(f.store.chunk(token, 0, new Uint8Array(size))).rejects.toThrow('must be smaller');
    expect(readdirSync(f.dir)).toEqual([]);
    await expect(f.store.finish(token)).rejects.toThrow('no longer held');
    expect(f.call).not.toHaveBeenCalledWith('attachmentRecompressed', expect.anything());
    await f.begin();
  });

  it('validates attachment ids, stored rows and the named replacement formats', async () => {
    const f = fixture();
    await expect(f.begin('not-a-snowflake')).rejects.toThrow();
    await expect(f.begin(ID, 'exe')).rejects.toThrow('format');
    f.call.mockResolvedValueOnce(null as never);
    await expect(f.begin()).rejects.toThrow('not stored');
    const withoutSize = fixture(false, null as never);
    await expect(withoutSize.begin()).rejects.toThrow('byte count');
    expect(readdirSync(f.dir)).toEqual([]);
  });

  it('reserves the old hash across rows and concurrent begins, releasing it after abort', async () => {
    const f = fixture();
    const starts = await Promise.allSettled([f.begin(), f.begin(OTHER_ID)]);
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const token = starts.find((r) => r.status === 'fulfilled')!;
    if (token.status !== 'fulfilled') throw new Error('Missing successful begin');
    await f.store.abort(token.value);
    expect(readdirSync(f.dir)).toEqual([]);
    await f.begin(OTHER_ID, 'mp4');
  });

  it('leaves a refused destination to core, which alone knows whether a download now names it', async () => {
    const f = fixture(true);
    const token = await f.begin();
    await f.store.chunk(token, 0, BODY);
    await expect(f.store.finish(token)).rejects.toThrow('Core refused');
    expect(existsSync(f.dest)).toBe(true); // core's refusal removes it unless named (attachmentStore.test.ts)
    expect(readdirSync(f.dir).some((name) => name.startsWith(PARTIAL_DOWNLOAD_PREFIX))).toBe(false);
    await f.begin();
  });

  it('preserves a deduplicated destination when core refuses', async () => {
    const f = fixture(true);
    mkdirSync(dirname(f.dest), { recursive: true });
    writeFileSync(f.dest, BODY);
    const token = await f.begin();
    await f.store.chunk(token, 0, BODY);
    await expect(f.store.finish(token)).rejects.toThrow('Core refused');
    expect(readFileSync(f.dest)).toEqual(BODY);
  });

  it('adopts content already stored under another extension instead of adding a second copy', async () => {
    const f = fixture();
    const held = join(dirname(f.dest), `${NEW_SHA}.png`);
    mkdirSync(dirname(held), { recursive: true });
    writeFileSync(held, BODY);
    const token = await f.begin();
    await f.store.chunk(token, 0, BODY);
    await f.store.finish(token);
    expect(readdirSync(dirname(held))).toEqual([`${NEW_SHA}.png`]);
    expect(f.call).toHaveBeenLastCalledWith('attachmentRecompressed', {
      sha256: OLD_SHA, newSha256: NEW_SHA, storedExt: 'png', bytes: BODY.length,
    });
  });

  it('drops an idle partial and permits a new writer for its hash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture();
    const token = await f.begin();
    await f.store.chunk(token, 0, BODY);
    expect(readdirSync(f.dir).some((name) => name.startsWith(PARTIAL_DOWNLOAD_PREFIX))).toBe(true);
    await vi.advanceTimersByTimeAsync(REPLACEMENT_IDLE_MS);
    await vi.waitFor(() => expect(readdirSync(f.dir)).toEqual([]));
    await expect(f.store.finish(token)).rejects.toThrow('no longer held');
    await f.begin();
  });
});
