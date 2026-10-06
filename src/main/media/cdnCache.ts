// Discord CDN files (emoji, server icons, avatars) fetched once through the Discord session and kept on disk.
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Session } from 'electron';
import { emojiExt } from '@shared/emoji';

export const DISCORD_CDN = 'https://cdn.discordapp.com';
/** A signed attachment URL that expired answers one of these; a fresh one is read from its message. */
export const EXPIRED_STATUSES: ReadonlySet<number> = new Set([403, 404]);
/** Largest render is a jumbo emoji (--cp-emoji-jumbo, 48 CSS px); 128 keeps it sharp up to ~2.5x displays. */
export const EMOJI_SIZE_PX = 128;

/** Downloads in progress by file: a second request for one waits on the first rather than fetching it again. */
const inFlight = new Map<string, Promise<number | null>>();

/** Fetches `url` into `file` unless it is already there. Resolves null once stored, else the upstream HTTP status. */
export function fetchOnceToFile(ses: Session, url: string, file: string): Promise<number | null> {
  if (existsSync(file)) return Promise.resolve(null);
  let run = inFlight.get(file);
  if (!run) {
    run = download(ses, url, file).finally(() => inFlight.delete(file));
    inFlight.set(file, run);
  }
  return run;
}

/** Written beside `file` and renamed into place, so a reader never sees it half written. */
async function download(ses: Session, url: string, file: string): Promise<number | null> {
  const res = await ses.fetch(url);
  if (!res.ok) return res.status;
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.part`;
  await writeFile(part, Buffer.from(await res.arrayBuffer()));
  await rename(part, file);
  return null;
}

export const emojiFile = (dir: string, id: string, animated: boolean): string => join(dir, `${id}.${emojiExt(animated)}`);

/** Downloads one custom emoji into the media store (no-op when already there). Returns the file path. */
export async function ensureEmoji(ses: Session, dir: string, id: string, animated: boolean): Promise<string> {
  const file = emojiFile(dir, id, animated);
  const status = await fetchOnceToFile(ses, `${DISCORD_CDN}/emojis/${id}.${emojiExt(animated)}?size=${EMOJI_SIZE_PX}`, file);
  if (status !== null) throw new Error(`HTTP ${status}`);
  return file;
}
