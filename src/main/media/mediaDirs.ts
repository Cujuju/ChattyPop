// The archive's media folder layout. Names must stay byte-identical: a renamed folder orphans its cache.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_ATTACHMENTS_DIR, ARCHIVE_MEDIA_DIR } from '@shared/types/storage';
import { EMOJI_SIZE_PX } from './cdnCache';

/** Named by fetch size so a size change starts a fresh cache instead of serving old low-res files. */
const EMOJI_DIR = `emojis-${EMOJI_SIZE_PX}`;
/** Superseded media caches, removed at startup: earlier emoji sizes; webp-only link previews (now 'previews'). */
const LEGACY_CACHE_DIRS = ['emojis', 'thumbs'];

export interface MediaDirs {
  media: string;
  /** Archived attachments, content-addressed. */
  attachments: string;
  emojis: string;
  /** Server icons. */
  icons: string;
  /** Link-preview images: bytes plus content type. */
  previews: string;
  avatars: string;
  /** Full-size media from the preview hosts. */
  proxied: string;
  /** Lottie stickers' animations (JSON). */
  stickers: string;
  /** Discord's Nitro display-name fonts. */
  nameFonts: string;
}

export function mediaDirs(archiveDir: string): MediaDirs {
  const media = join(archiveDir, ARCHIVE_MEDIA_DIR);
  return {
    media,
    attachments: join(media, ARCHIVE_ATTACHMENTS_DIR),
    emojis: join(media, EMOJI_DIR),
    icons: join(media, 'icons'),
    previews: join(media, 'previews'),
    avatars: join(media, 'avatars'),
    proxied: join(media, 'proxied'),
    stickers: join(media, 'stickers'),
    nameFonts: join(media, 'name-fonts'),
  };
}

export function removeLegacyCaches(dirs: MediaDirs): void {
  for (const d of LEGACY_CACHE_DIRS) rmSync(join(dirs.media, d), { recursive: true, force: true });
}
