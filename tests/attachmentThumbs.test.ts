import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentShard, attachmentThumbUrl, setMediaRoot } from '@shared/media';

const env = vi.hoisted(() => ({ supported: true, thumbnail: vi.fn(), jpeg: vi.fn(), empty: vi.fn() }));
vi.mock('electron', () => ({ protocol: {}, nativeImage: { get createThumbnailFromPath() { return env.supported ? env.thumbnail : undefined; } } }));
const { mediaHandler } = await import('../src/main/media/mediaProtocol');
const { mediaDirs } = await import('../src/main/media/mediaDirs');
const { ATTACHMENT_THUMB_PX, ATTACHMENT_THUMB_JPEG_QUALITY, backfillAttachmentThumbs, keepAttachmentThumb } = await import('../src/main/media/attachmentThumbs');
const SHA = 'a'.repeat(64);
const NAME = `${SHA}.png`;
const JPEG = Buffer.from('jpeg thumbnail');
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const roots: string[] = [];

function fixture(stored = true) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-attachment-thumb-'));
  roots.push(dir);
  const dirs = mediaDirs(dir);
  const file = join(dirs.attachments, attachmentShard(SHA), NAME);
  mkdirSync(join(dirs.attachments, attachmentShard(SHA)), { recursive: true });
  if (stored) writeFileSync(file, 'original');
  const serve = mediaHandler(dirs, {} as never, {} as never, async () => null);
  const request = () => serve(new URL(`cp-media://attachment-thumb/${NAME}`));
  return { dirs, file, serve, request, cache: join(dirs.previews, `attachment-thumb-${SHA}.jpg`) };
}

beforeEach(() => {
  env.supported = true;
  env.thumbnail.mockReset().mockResolvedValue({ toJPEG: env.jpeg, isEmpty: env.empty });
  env.jpeg.mockReset().mockReturnValue(JPEG);
  env.empty.mockReset().mockReturnValue(false);
});
afterEach(() => {
  setMediaRoot('cp-media://');
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('attachment thumbnail route', () => {
  it('makes one JPEG for concurrent requests, caches by sha and serves immutable headers', async () => {
    const f = fixture();
    const responses = await Promise.all([f.request(), f.request(), f.request()]);
    expect(env.thumbnail).toHaveBeenCalledTimes(1);
    expect(env.thumbnail).toHaveBeenCalledWith(f.file, { width: ATTACHMENT_THUMB_PX, height: ATTACHMENT_THUMB_PX });
    expect(env.jpeg).toHaveBeenCalledWith(ATTACHMENT_THUMB_JPEG_QUALITY);
    expect(readFileSync(f.cache)).toEqual(JPEG);
    for (const response of responses) {
      expect(response.status).toBe(HTTP_OK);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG);
    }
    await f.request();
    expect(env.thumbnail).toHaveBeenCalledTimes(1);
  });

  it.each(['bad.png', `${SHA}.PNG`, `${SHA}.png.exe`, `${SHA}.toolongext`, `${SHA}`, `${NAME}/extra`, `%2e%2e`, '%2f', ''])('refuses invalid names: %s', async (name) => {
    const f = fixture();
    const response = await f.serve(new URL(`cp-media://attachment-thumb/${name}`));
    expect(response.status).toBe(HTTP_NOT_FOUND);
    expect(response.headers.get('cache-control')).toBeNull();
    expect(env.thumbnail).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing local file', async () => {
    const f = fixture(false);
    expect((await f.request()).status).toBe(HTTP_NOT_FOUND);
    expect(env.thumbnail).not.toHaveBeenCalled();
  });

  it('returns 404 on unsupported native decoding and retries later', async () => {
    const f = fixture();
    env.thumbnail.mockRejectedValueOnce(new Error('Unsupported image'));
    expect((await f.request()).status).toBe(HTTP_NOT_FOUND);
    expect(existsSync(f.cache)).toBe(false);
    expect((await f.request()).status).toBe(HTTP_OK);
  });

  it('returns 404 for an empty native image', async () => {
    const f = fixture();
    env.empty.mockReturnValue(true);
    expect((await f.request()).status).toBe(HTTP_NOT_FOUND);
    expect(existsSync(f.cache)).toBe(false);
  });

  it('returns 404 when Electron omits thumbnail support, as on Linux', async () => {
    const f = fixture();
    env.supported = false;
    expect((await f.request()).status).toBe(HTTP_NOT_FOUND);
    expect(env.thumbnail).not.toHaveBeenCalled();
    expect(existsSync(f.cache)).toBe(false);
  });

  it('routes phone and remote URLs through the installed media root', () => {
    setMediaRoot('/media/', { emoji: 'native-emoji://' });
    expect(attachmentThumbUrl({ sha256: SHA, filename: 'photo.png', storedExt: null })).toBe(`/media/attachment-thumb/${NAME}`);
  });
});

describe('thumbnails ahead of view', () => {
  /** Stores `name` under its hash's shard. */
  const store = (attachments: string, name: string): string => {
    const shard = join(attachments, attachmentShard(name));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, name), 'original');
    return join(shard, name);
  };

  it('makes each stored picture missing a thumbnail, one at a time, and nothing else', async () => {
    const { dirs } = fixture(false);
    const [made, kept, video, audio] = ['b', 'c', 'd', 'e'].map((c) => c.repeat(64));
    const picture = store(dirs.attachments, `${made}.jpg`);
    const clip = store(dirs.attachments, `${video}.mp4`);
    store(dirs.attachments, `${kept}.png`);
    store(dirs.attachments, `${audio}.ogg`);
    store(dirs.attachments, `.part-${made}`);
    writeFileSync(join(dirs.attachments, '.part-elsewhere'), 'partial');
    mkdirSync(dirs.previews, { recursive: true });
    writeFileSync(join(dirs.previews, `attachment-thumb-${kept}.jpg`), JPEG);
    let running = 0;
    let most = 0;
    env.thumbnail.mockImplementation(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r));
      running--;
      return { toJPEG: env.jpeg, isEmpty: env.empty };
    });
    await backfillAttachmentThumbs(dirs.attachments, dirs.previews, () => false);
    expect(env.thumbnail.mock.calls.map(([file]) => file).sort()).toEqual([picture, clip].sort());
    expect(most).toBe(1);
    expect(readFileSync(join(dirs.previews, `attachment-thumb-${made}.jpg`))).toEqual(JPEG);
  });

  it("removes thumbnails whose file left the store, and nothing else in previews", async () => {
    const { dirs } = fixture(false);
    const [kept, freed] = ['b', 'c'].map((c) => c.repeat(64)) as [string, string];
    store(dirs.attachments, `${kept}.png`);
    mkdirSync(dirs.previews, { recursive: true });
    const thumb = (sha: string): string => join(dirs.previews, `attachment-thumb-${sha}.jpg`);
    for (const name of [thumb(kept), thumb(freed), join(dirs.previews, 'poster-123.jpg')]) writeFileSync(name, JPEG);
    await backfillAttachmentThumbs(dirs.attachments, dirs.previews, () => false);
    expect([existsSync(thumb(kept)), existsSync(thumb(freed)), existsSync(join(dirs.previews, 'poster-123.jpg'))]).toEqual([true, false, true]);
  });

  it('removes nothing while the store, or one of its shards, cannot be read', async () => {
    const { dirs } = fixture(false);
    const orphan = join(dirs.previews, `attachment-thumb-${'c'.repeat(64)}.jpg`);
    mkdirSync(dirs.previews, { recursive: true });
    writeFileSync(orphan, JPEG);
    rmSync(dirs.attachments, { recursive: true, force: true });
    await backfillAttachmentThumbs(dirs.attachments, dirs.previews, () => false);
    expect(existsSync(orphan)).toBe(true);
    // A shard name that is a file: its listing fails.
    mkdirSync(dirs.attachments, { recursive: true });
    writeFileSync(join(dirs.attachments, 'ab'), 'not a folder');
    await backfillAttachmentThumbs(dirs.attachments, dirs.previews, () => false);
    expect(existsSync(orphan)).toBe(true);
  });

  it('stops when told to', async () => {
    const { dirs } = fixture();
    await backfillAttachmentThumbs(dirs.attachments, dirs.previews, () => true);
    expect(env.thumbnail).not.toHaveBeenCalled();
  });

  it('keeps a downloaded picture, not other kinds or names', async () => {
    const { dirs, file, cache } = fixture();
    await keepAttachmentThumb(dirs.attachments, dirs.previews, `${'f'.repeat(64)}.ogg`);
    await keepAttachmentThumb(dirs.attachments, dirs.previews, 'notes.png');
    expect(env.thumbnail).not.toHaveBeenCalled();
    await keepAttachmentThumb(dirs.attachments, dirs.previews, NAME);
    expect(env.thumbnail).toHaveBeenCalledWith(file, { width: ATTACHMENT_THUMB_PX, height: ATTACHMENT_THUMB_PX });
    expect(existsSync(cache)).toBe(true);
  });
});
