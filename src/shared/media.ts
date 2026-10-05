import { STICKER_FORMAT } from './compose';
import type { MediaSize } from './types/archive';

/** Scheme serving locally cached Discord media to the renderer. */
export const MEDIA_SCHEME = 'cp-media';

/** Prefix of every media URL: the scheme in Electron windows; the companion server's /media/ path on a phone. */
let mediaRoot = `${MEDIA_SCHEME}://`;
/** Set once at startup, before anything renders. */
export const setMediaRoot = (root: string): void => {
  mediaRoot = root;
};
/** A media URL: route host (avatar, thumb, …) then the rest of the path and query. */
export const mediaUrl = (route: string, rest: string): string => `${mediaRoot}${route}/${rest}`;

/** Stands in for the hash of a user with no avatar: Discord's default avatar is served instead. */
export const DEFAULT_AVATAR = 'default';
/** A user's avatar, fetched once through the Discord session and cached. `large`: at the profile window's size. */
export const avatarUrl = (userId: string, hash: string | null, large = false): string =>
  mediaUrl('avatar', `${userId}/${hash ?? DEFAULT_AVATAR}${large ? '/large' : ''}`);
/** A user's profile banner. */
export const bannerUrl = (userId: string, hash: string): string => mediaUrl('banner', `${userId}/${hash}`);
/** A profile badge's icon. */
export const badgeUrl = (hash: string): string => mediaUrl('badge', hash);

export const guildIconUrl = (guildId: string, iconHash: string): string => mediaUrl('icon', `${guildId}/${iconHash}`);
/** A group DM's own icon. */
export const groupIconUrl = (channelId: string, iconHash: string): string => mediaUrl('channel-icon', `${channelId}/${iconHash}`);
/** The icon of a role, drawn beside its members' names. */
export const roleIconUrl = (roleId: string, iconHash: string): string => mediaUrl('role-icon', `${roleId}/${iconHash}`);
/** A user's avatar decoration: still, or animated (while their message is hovered). `large`: at the profile window's size. */
export const decorationUrl = (asset: string, animated: boolean, large = false): string =>
  mediaUrl('decoration', `${asset}/${animated ? 'animated' : 'still'}${large ? '/large' : ''}`);
/** The badge of a server tag, drawn beside the name of a user who shows it. */
export const tagBadgeUrl = (guildId: string, badgeHash: string): string => mediaUrl('tag-badge', `${guildId}/${badgeHash}`);

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/** Lower-case extension of a filename, or 'bin' when missing/unsafe. */
export function fileExt(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return SAFE_EXT.test(ext) ? ext : 'bin';
}

/** Archived attachments are stored as <attachments dir>/<shard>/<attachmentFileName>; the shard is the hash's first characters. */
const ATTACHMENT_SHARD_CHARS = 2;
export const attachmentShard = (sha256: string): string => sha256.slice(0, ATTACHMENT_SHARD_CHARS);

/** Served MIME by stored extension; anything else downloads as opaque bytes. */
export const STORED_MEDIA_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

/** Stored name of an archived attachment: content hash plus the original extension (drives the served MIME type). */
export const attachmentFileName = (sha256: string, filename: string): string => `${sha256}.${fileExt(filename)}`;

export const attachmentUrl = (sha256: string, filename: string): string => mediaUrl('attachment', attachmentFileName(sha256, filename));

/** Discord marks an attachment a spoiler by this filename prefix: its clients cover it until clicked. */
const SPOILER_PREFIX = 'SPOILER_';
export const isSpoilerName = (filename: string): boolean => filename.startsWith(SPOILER_PREFIX);
/** `filename` with the spoiler mark set or cleared. */
export const spoilerName = (filename: string, spoiler: boolean): string => {
  const bare = isSpoilerName(filename) ? filename.slice(SPOILER_PREFIX.length) : filename;
  return spoiler ? `${SPOILER_PREFIX}${bare}` : bare;
};

/** A content type that says nothing about the media; the stored extension decides instead. */
export const GENERIC_CONTENT_TYPE = 'application/octet-stream';

/** How a stored attachment shows inline: an image, an audio player (length fetched up front) or a video (first frame fetched up front). Others are file chips. */
export type AttachmentView = 'image' | 'audio' | 'video' | 'file';
export function attachmentView(a: { status: string; contentType: string | null; filename: string }): AttachmentView {
  return a.status === 'stored' ? mediaKind(a) : 'file';
}

/** Embeds whose images are a video's still or an animation, not a picture shared to be read. */
const MOVING_EMBED_TYPES: ReadonlySet<string> = new Set(['video', 'gifv']);
/** Whether an embed's image and thumbnail are pictures (a link preview's, an image link's), not a video's frames. */
export const embedShowsPictures = (type: string): boolean => !MOVING_EMBED_TYPES.has(type);
/** Embeds whose video has no sound: a GIF. */
const SILENT_EMBED_TYPES: ReadonlySet<string> = new Set(['gifv']);
/** Whether an embed's video may have sound to transcribe. */
export const embedVideoHasSound = (type: string): boolean => !SILENT_EMBED_TYPES.has(type);

/** What an attachment holds, by its content type, else its extension; 'file' for anything but image, audio or video. */
export function mediaKind(a: { contentType: string | null; filename: string }): AttachmentView {
  const known = a.contentType && a.contentType !== GENERIC_CONTENT_TYPE ? a.contentType : STORED_MEDIA_MIME[fileExt(a.filename)];
  const kind = (known ?? '').split('/')[0];
  return kind === 'image' || kind === 'audio' || kind === 'video' ? kind : 'file';
}

/** Discord media-proxy hosts the thumb and proxied routes may fetch from. */
export const DISCORD_MEDIA_PROXY_HOST = /^(media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/;
/** X's image host (photos, video stills, avatars of posts filled from FxTwitter); fetched without Discord's session. */
export const X_MEDIA_HOST = /^pbs\.twimg\.com$/;

/** Klipy's media host: previews of Discord's GIF search results; fetched without Discord's session. */
export const KLIPY_MEDIA_HOST = /^static\.klipy\.com$/;
/** A GIF search preview, streamed on view and not kept (searches would otherwise fill the disk). */
export const gifPreviewUrl = (src: string): string => mediaUrl('gif', `?u=${encodeURIComponent(src)}`);

/** A Lottie sticker's animation (JSON), fetched once through the Discord session and cached. */
export const lottieStickerUrl = (stickerId: string): string => mediaUrl('sticker', `${stickerId}.json`);
/** A PNG, APNG or GIF sticker's art through Discord's media proxy (cached by the thumb route). */
export const stickerArtUrl = (s: { id: string; formatType: number }): string =>
  thumbUrl(`https://media.discordapp.net/stickers/${s.id}.${s.formatType === STICKER_FORMAT.gif ? 'gif' : 'png'}`);

/** An app's icon (slash command menu) through Discord's media proxy (cached by the thumb route). */
export const appIconUrl = (appId: string, icon: string): string => thumbUrl(`https://media.discordapp.net/app-icons/${appId}/${icon}.png`);

/**
 * The same image with its animation: Discord's media proxy sends only the first frame of an animated image (an embed
 * fixer's GIF) unless asked. A still image comes back unchanged. Other hosts' URLs are returned as they are.
 */
export function animatedMediaUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (!DISCORD_MEDIA_PROXY_HOST.test(url.hostname)) return proxyUrl;
    url.searchParams.set('animated', 'true');
    return url.href;
  } catch {
    return proxyUrl;
  }
}

/** The pixel size on a Discord (or FxTwitter) media object; null unless both sides are positive numbers. */
export function mediaSize(v: { width?: unknown; height?: unknown } | null | undefined): MediaSize | null {
  const w = v?.width, h = v?.height;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Link-preview image (Discord media proxy or X image host), fetched once and cached. */
export const thumbUrl = (proxyUrl: string): string => mediaUrl('thumb', `?u=${encodeURIComponent(proxyUrl)}`);

/** Media at full size from the same hosts, cached as-is (GIF-style videos, full-resolution preview images). */
export const proxiedUrl = (proxyUrl: string): string => mediaUrl('proxied', `?u=${encodeURIComponent(proxyUrl)}`);
