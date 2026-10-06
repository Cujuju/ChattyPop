import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { Session } from 'electron';
import { DISCORD_MEDIA_PROXY_HOST, KLIPY_MEDIA_HOST, X_MEDIA_HOST } from '@shared/media';
import { BYTES_PER_MB } from '@shared/units';
import { DISCORD_CDN, EXPIRED_STATUSES } from './cdnCache';

/** Link cards show previews up to ~320 CSS px; a 640 box covers 2x displays. The proxy fits within the box. */
const THUMB_BOX_PX = 640;
/** X's named size nearest above THUMB_BOX_PX ('small' fits 680 px). */
const X_PREVIEW_SIZE = 'small';
/** X image paths that take format/name params; profile images answer 404 with them. */
const X_SIZED_PATH = /^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
/** X's name for the file as uploaded. */
const X_ORIGINAL_SIZE = 'orig';
/** A format every image decoder reads; Discord's proxy converts to it (WebP needs an optional Windows codec). */
const DECODABLE_FORMAT = 'png';
/** Written under this prefix, then renamed into place, so a reader never sees a partial file. */
const PARTIAL_PREFIX = '.part-';
/** Caps video responses at Discord’s Nitro upload size. Assumption: proxy embed videos fit this limit; confirm against Discord media limits. */
export const VIDEO_BYTES_MAX = 500 * BYTES_PER_MB;
/** What a video fetch keeps: video or audio, or bytes of no stated type; an error page (text/html) is refused. */
const VIDEO_TYPE = /^(video\/|audio\/|application\/octet-stream)/;
/** Concurrent fetches while scrolling the feed; a browser allows ~6 per host, stay under it. */
const MAX_CONCURRENT_FETCHES = 4;

let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_FETCHES) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export interface MediaSessions {
  /** Discord's media proxy, fetched as the embedded client. */
  discord: Session;
  /** Third-party media hosts (X images of posts filled from FxTwitter, Klipy GIF previews); carries no Discord cookies. */
  web: Session;
}

export interface Media {
  bytes: Buffer;
  type: string;
}

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The only remote hosts the media routes fetch from, with the session for each and its preview-sized URL; null otherwise. */
function remote(raw: string, s: MediaSessions): { url: URL; ses: Session; preview: URL } | null {
  const url = httpsUrl(raw);
  if (!url) return null;
  const preview = new URL(url);
  if (DISCORD_MEDIA_PROXY_HOST.test(url.hostname)) {
    preview.searchParams.set('format', 'webp');
    // The proxy ignores width alone for external images; with both it scales to fit.
    preview.searchParams.set('width', String(THUMB_BOX_PX));
    preview.searchParams.set('height', String(THUMB_BOX_PX));
    return { url, ses: s.discord, preview };
  }
  if (X_MEDIA_HOST.test(url.hostname)) {
    if (X_SIZED_PATH.test(url.pathname)) {
      preview.searchParams.set('format', 'webp');
      preview.searchParams.set('name', X_PREVIEW_SIZE);
    }
    return { url, ses: s.web, preview };
  }
  return null;
}

/** Fetched once and cached at <dir>/<sha256(key)>, its content type beside it in <file>.type; else the refusal's status. */
async function fetchCached(dir: string, key: string, ses: Session, fetchUrl: string): Promise<Media | { status: number }> {
  const file = join(dir, createHash('sha256').update(key).digest('hex'));
  if (existsSync(file) && existsSync(`${file}.type`)) return { bytes: await readFile(file), type: await readFile(`${file}.type`, 'utf8') };
  const res = await limited(() => ses.fetch(fetchUrl));
  if (!res.ok) return { status: res.status };
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dir, { recursive: true });
  await writeFile(file, bytes);
  await writeFile(`${file}.type`, type);
  return { bytes, type };
}

async function cached(dir: string, key: string, ses: Session, fetchUrl: string): Promise<Media | null> {
  const m = await fetchCached(dir, key, ses, fetchUrl);
  return 'status' in m ? null : m;
}

/** Link-preview image, scaled by its host to fit THUMB_BOX_PX where the host can; null for hosts not in remote(). */
export async function thumb(s: MediaSessions, dir: string, raw: string): Promise<Media | null> {
  const r = remote(raw, s);
  return r ? cached(dir, r.url.href, r.ses, r.preview.href) : null;
}

/** Discord's attachment CDN. Its media proxy serves the same signed path, and a still frame of a video. */
const ATTACHMENT_CDN_HOST = new URL(DISCORD_CDN).hostname;
const ATTACHMENT_PROXY_HOST = 'media.discordapp.net';
/** Poster cache keys: by attachment id, since its signed URL changes. */
const POSTER_KEY_PREFIX = 'attachment-poster:';

/** Where a video attachment's still comes from: its archived CDN URL, then a fresh one once that expired. */
export interface PosterSource {
  stored: string;
  fresh(): Promise<string | undefined>;
}

/** A video attachment's still, from Discord's media proxy at THUMB_BOX_PX; null when the proxy gives none. */
export async function attachmentPoster(s: MediaSessions, dir: string, attachmentId: string, source: PosterSource): Promise<Media | null> {
  const from = async (cdnUrl: string | undefined): Promise<Media | { status: number } | null> => {
    const url = cdnUrl ? httpsUrl(cdnUrl) : null;
    if (url?.hostname !== ATTACHMENT_CDN_HOST) return null;
    url.hostname = ATTACHMENT_PROXY_HOST;
    const r = remote(url.href, s)!;
    return fetchCached(dir, POSTER_KEY_PREFIX + attachmentId, r.ses, r.preview.href);
  };
  const first = await from(source.stored);
  if (!first || !('status' in first)) return first;
  if (!EXPIRED_STATUSES.has(first.status)) return null;
  const again = await from(await source.fresh());
  return again && !('status' in again) ? again : null;
}

/** A GIF search preview from Klipy's host, fetched without Discord's session and not stored; null for other hosts. */
export async function gifPreview(s: MediaSessions, raw: string): Promise<Media | null> {
  const url = httpsUrl(raw);
  if (!url || !KLIPY_MEDIA_HOST.test(url.hostname)) return null;
  const res = await limited(() => s.web.fetch(url.href));
  if (!res.ok) return null;
  return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Downloads full-size shown images to path without caching: Discord proxy PNG or original X images. Returns null or failure reason. */
export async function fetchImageTo(s: MediaSessions, raw: string, path: string): Promise<string | null> {
  const r = remote(raw, s);
  if (!r) return 'Not an image host ChattyPop fetches from.';
  const full = new URL(r.url);
  if (DISCORD_MEDIA_PROXY_HOST.test(full.hostname)) full.searchParams.set('format', DECODABLE_FORMAT);
  else if (X_SIZED_PATH.test(full.pathname)) full.searchParams.set('name', X_ORIGINAL_SIZE);
  const partial = join(dirname(path), `${PARTIAL_PREFIX}${randomUUID()}-${basename(path)}`);
  try {
    const res = await limited(() => r.ses.fetch(full.href));
    if (!res.ok) return `HTTP ${res.status}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(partial, Buffer.from(await res.arrayBuffer()));
    await rename(partial, path);
    return null;
  } catch (err) {
    await rm(partial, { force: true });
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * A video a message's embed shows (archive.parts: Discord's media proxy, through the Discord session) streamed to `path`
 * as served, not cached; at most VIDEO_BYTES_MAX. Null when written, else why not.
 */
export async function fetchVideoTo(s: MediaSessions, raw: string, path: string): Promise<string | null> {
  const url = httpsUrl(raw);
  if (!url || !DISCORD_MEDIA_PROXY_HOST.test(url.hostname)) return 'Not a video host ChattyPop fetches from.';
  const tooLarge = `Larger than ${VIDEO_BYTES_MAX / BYTES_PER_MB} MB.`;
  const partial = join(dirname(path), `${PARTIAL_PREFIX}${randomUUID()}-${basename(path)}`);
  try {
    const res = await limited(() => s.discord.fetch(url.href));
    if (!res.ok || !res.body) return `HTTP ${res.status}`;
    const type = res.headers.get('content-type');
    const refused = type && !VIDEO_TYPE.test(type) ? `Not a video (${type}).` :Number(res.headers.get('content-length')) > VIDEO_BYTES_MAX ? tooLarge : null;
    if (refused) {
      await res.body.cancel();
      return refused;
    }
    await mkdir(dirname(path), { recursive: true });
    let bytes = 0;
    const capped = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > VIDEO_BYTES_MAX ? new Error(tooLarge) : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), capped, createWriteStream(partial));
    await rename(partial, path);
    return null;
  } catch (err) {
    await rm(partial, { force: true });
    return err instanceof Error ? err.message : String(err);
  }
}

/** Media at full size, kept as-is (GIF-style videos, full images); null for hosts not in remote(). */
export async function proxiedMedia(s: MediaSessions, dir: string, raw: string): Promise<Media | null> {
  const r = remote(raw, s);
  return r ? cached(dir, r.url.href, r.ses, r.url.href) : null;
}
