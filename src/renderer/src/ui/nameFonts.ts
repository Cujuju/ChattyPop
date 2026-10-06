// Nitro display-name fonts: each is registered once, on first use, from the media route that fetches Discord's file.
import { mediaUrl } from '@shared/media';
import type { NameFont } from '@shared/nameFonts';

const registered = new Set<string>();

/** Registers cp-name-key fonts; failed loads clear caches for retries. */
export function ensureNameFont(f: NameFont): void {
  if (registered.has(f.key)) return;
  registered.add(f.key);
  // Any weight: the file has one, and the name's weight must not pick a fallback face or a synthesised bold.
  const face = new FontFace(`cp-name-${f.key}`, `url("${mediaUrl('name-font', encodeURIComponent(f.family))}")`, { weight: '100 900' });
  document.fonts.add(face);
  face.load().catch(() => {
    document.fonts.delete(face);
    registered.delete(f.key);
  });
}
