import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { protocol, type CustomScheme, type Session } from 'electron';
import { SNOWFLAKE_DIGITS, SNOWFLAKE_ID, SNOWFLAKE_TIMESTAMP_SHIFT } from '@shared/discord';
import { DEFAULT_AVATAR, GENERIC_CONTENT_TYPE, MEDIA_SCHEME, STORED_MEDIA_MIME, attachmentShard } from '@shared/media';
import { isNameFontFamily } from '@shared/nameFonts';
import { DISCORD_CDN, ensureEmoji, fetchOnceToFile } from './cdnCache';
import type { MediaDirs } from './mediaDirs';
import { rangedResponse } from './ranges';
import { gifPreview, proxiedMedia, thumb, type Media, type MediaSessions } from './thumbStore';

/** Rendered at 20–32 CSS px; 64 covers 2x displays. */
const ICON_SIZE_PX = 64;
/** The profile window's avatar and its decoration (Discord: 120px avatar) on 2x displays. */
const PROFILE_IMAGE_SIZE_PX = 256;
/** A profile banner, drawn about 340px wide, on 2x displays. */
const BANNER_SIZE_PX = 1024;
/** Route segment asking for an image at the profile window's size. */
const LARGE = 'large';
const ICON_HASH = /^(a_)?[0-9a-f]{32}$/;
const ATTACHMENT_FILE = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/;
const EMOJI_FILE = new RegExp(String.raw`^(${SNOWFLAKE_DIGITS})\.(gif|webp)$`);
const LOTTIE_FILE = new RegExp(String.raw`^(${SNOWFLAKE_DIGITS})\.json$`);
/** Status served when the upstream fetch itself failed (offline, DNS). */
const BAD_GATEWAY = 502;

/** Must run before app ready, and only once for all schemes (Electron honours a single call): pass the others in `with`. */
export function registerMediaScheme(withSchemes: CustomScheme[] = []): void {
  // corsEnabled: the renderer's page is another origin, and fetch() (Lottie sticker JSON) is a CORS request.
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }, ...withSchemes]);
}

const notFound = (): Response => new Response('not found', { status: 404 });
const upstreamError = (status: number): Response => new Response('upstream error', { status });
const serveMedia = (m: Media | null, range: string | null): Response =>
  m ? rangedResponse(range, m.bytes.length, m.type, (start, end) => new Uint8Array(m.bytes.subarray(start, end + 1))) : notFound();

/**
 * cp-media://icon/<guildId>/<hash>      server icon, fetched once through the Discord session and cached.
 * cp-media://role-icon/<roleId>/<hash>  role icon beside a member's name, likewise.
 * cp-media://tag-badge/<guildId>/<hash> server tag badge beside a user's name, likewise.
 * cp-media://channel-icon/<channelId>/<hash> a group DM's icon, likewise.
 * cp-media://decoration/<asset>[/animated] avatar decoration, still or animated, likewise.
 * cp-media://name-font/<family>          a Nitro display-name font, found in the Discord page's CSS, fetched once and cached.
 * cp-media://attachment/<sha256>.<ext>  archived attachment from the content-addressed store.
 * cp-media://thumb/?u=<media url>        link-preview image (Discord's media proxy or X's image host), cached.
 * cp-media://proxied/?u=<media url>      full-size media from the same hosts (GIF videos, full images), cached as-is.
 * cp-media://avatar/<userId>/<hash|default>[/large] user avatar, fetched once through the Discord session and cached.
 * cp-media://banner/<userId>/<hash>      profile banner; cp-media://badge/<hash>: profile badge icon. Same session, cached.
 * cp-media://gif/?u=<Klipy url>          GIF search preview, fetched without Discord's session, not stored.
 * cp-media://sticker/<id>.json           Lottie sticker animation, fetched once through the Discord session and cached.
 * Attachments and the thumb, proxied and gif routes answer 
ange (the request's Range header) with the bytes it asks for.
 */
export type MediaHandler = (url: URL, range?: string | null) => Promise<Response>;

/** `fontUrl`: where the Discord page loads a display-name font family from; null while it can't say. */
export function mediaHandler(dirs: MediaDirs, sessions: MediaSessions, fontUrl: (family: string) => Promise<string | null>): MediaHandler {
  const discordSession = sessions.discord;
  return async (url, range = null) => {
    const parts = url.pathname.split('/').filter(Boolean);
    const icon = CDN_ICONS[url.host];
    if (icon) return serveIcon(dirs.icons, discordSession, icon, parts[0], parts[1]);
    if (url.host === 'avatar') return serveAvatar(dirs.avatars, discordSession, parts[0], parts[1], parts[2] === LARGE);
    if (url.host === 'decoration') return serveDecoration(dirs.icons, discordSession, parts[0], parts[1] === 'animated', parts[2] === LARGE);
    if (url.host === 'badge') return serveBadge(dirs.icons, discordSession, parts[0]);
    if (url.host === 'name-font') return serveNameFont(dirs.nameFonts, discordSession, fontUrl, decodeURIComponent(parts[0] ?? ''));
    if (url.host === 'attachment') return serveAttachment(dirs.attachments, parts[0], range);
    if (url.host === 'emoji') return serveEmoji(dirs.emojis, discordSession, parts[0]);
    if (url.host === 'proxied') return serveMedia(await proxiedMedia(sessions, dirs.proxied, url.searchParams.get('u') ?? '').catch(() => null), range);
    if (url.host === 'thumb') return serveMedia(await thumb(sessions, dirs.previews, url.searchParams.get('u') ?? '').catch(() => null), range);
    if (url.host === 'gif') return serveMedia(await gifPreview(sessions, url.searchParams.get('u') ?? '').catch(() => null), range);
    if (url.host === 'sticker') return serveLottie(dirs.stickers, discordSession, parts[0]);
    return notFound();
  };
}

/** Serves cp-media:// in Electron windows; the companion server serves the same routes over HTTP. */
export function handleMediaScheme(handler: MediaHandler): void {
  protocol.handle(MEDIA_SCHEME, (req) => handler(new URL(req.url), req.headers.get('range')));
}

/** cp-media://sticker/<id>.json: a Lottie sticker's animation, from Discord's asset host (where the live client loads it). */
async function serveLottie(dir: string, ses: Session, name?: string): Promise<Response> {
  const m = name ? LOTTIE_FILE.exec(name) : null;
  if (!m) return notFound();
  const file = join(dir, name!);
  const status = await fetchOnceToFile(ses, `https://discord.com/stickers/${m[1]!}.json`, file).catch(() => BAD_GATEWAY);
  if (status !== null) return upstreamError(status);
  // Read with fetch() from the renderer's origin; the JSON is public sticker art, so any origin may read it.
  return new Response(await readFile(file), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
}

/** cp-media://emoji/<id>.<gif|webp>: from the store, fetched on first view if the queue hasn't reached it. */
async function serveEmoji(dir: string, ses: Session, name?: string): Promise<Response> {
  const m = name ? EMOJI_FILE.exec(name) : null;
  if (!m) return notFound();
  try {
    const file = await ensureEmoji(ses, dir, m[1]!, m[2] === 'gif');
    return new Response(await readFile(file), { headers: { 'content-type': STORED_MEDIA_MIME[m[2]!]! } });
  } catch {
    return notFound();
  }
}

/** Images Discord's CDN keeps by owner id and hash. `prefix`: of the cached file's name ('' for server icons, as stored before the others). */
interface CdnIcon {
  path: string;
  prefix: string;
  /** Pixels asked of the CDN. */
  size: number;
}
const CDN_ICONS: Readonly<Record<string, CdnIcon>> = {
  icon: { path: 'icons', prefix: '', size: ICON_SIZE_PX },
  'role-icon': { path: 'role-icons', prefix: 'role-', size: ICON_SIZE_PX },
  'tag-badge': { path: 'clan-badges', prefix: 'tag-', size: ICON_SIZE_PX },
  'channel-icon': { path: 'channel-icons', prefix: 'channel-', size: ICON_SIZE_PX },
  banner: { path: 'banners', prefix: 'banner-', size: BANNER_SIZE_PX },
};

async function serveIcon(iconDir: string, ses: Session, kind: CdnIcon, ownerId?: string, hash?: string): Promise<Response> {
  if (!ownerId || !hash || !SNOWFLAKE_ID.test(ownerId) || !ICON_HASH.test(hash)) return notFound();
  const file = join(iconDir, `${kind.prefix}${ownerId}-${hash}.webp`);
  const status = await fetchOnceToFile(ses, `${DISCORD_CDN}/${kind.path}/${ownerId}/${hash}.webp?size=${kind.size}`, file);
  if (status !== null) return upstreamError(status);
  return new Response(await readFile(file), { headers: { 'content-type': 'image/webp' } });
}

/** cp-media://badge/<hash>: a profile badge's icon (Discord keeps them by hash alone). */
async function serveBadge(iconDir: string, ses: Session, hash?: string): Promise<Response> {
  if (!hash || !ICON_HASH.test(hash)) return notFound();
  const file = join(iconDir, `badge-${hash}.png`);
  const status = await fetchOnceToFile(ses, `${DISCORD_CDN}/badge-icons/${hash}.png`, file);
  if (status !== null) return upstreamError(status);
  return new Response(await readFile(file), { headers: { 'content-type': 'image/png' } });
}

/** Discord's decoration is 1.2x the avatar; 96 covers a 36px avatar's frame on 2x displays. */
const DECORATION_SIZE_PX = 96;

/** Animated: Discord's APNG (passthrough), shown while the message is hovered; still otherwise. */
async function serveDecoration(dir: string, ses: Session, asset: string | undefined, animated: boolean, large: boolean): Promise<Response> {
  if (!asset || !ICON_HASH.test(asset)) return notFound();
  const file = join(dir, `decoration-${asset}${animated ? '-animated' : ''}${large ? '-large' : ''}.png`);
  const src = `${DISCORD_CDN}/avatar-decoration-presets/${asset}.png?size=${large ? PROFILE_IMAGE_SIZE_PX : DECORATION_SIZE_PX}&passthrough=${animated}`;
  const status = await fetchOnceToFile(ses, src, file);
  if (status !== null) return upstreamError(status);
  return new Response(await readFile(file), { headers: { 'content-type': 'image/png' } });
}

/** A display-name font: from the store, else from where the Discord page loads it (its file names change per deploy). */
async function serveNameFont(dir: string, ses: Session, fontUrl: (family: string) => Promise<string | null>, family: string): Promise<Response> {
  if (!isNameFontFamily(family)) return notFound();
  const file = join(dir, `${family}.woff2`);
  if (!existsSync(file)) {
    const src = await fontUrl(family);
    if (!src) return notFound();
    const status = await fetchOnceToFile(ses, src, file);
    if (status !== null) return upstreamError(status);
  }
  return new Response(await readFile(file), { headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' } });
}

/** Discord's default avatars are numbered 0..5, chosen from the user id. */
const DEFAULT_AVATAR_COUNT = 6n;

async function serveAvatar(dir: string, ses: Session, userId: string | undefined, hash: string | undefined, large: boolean): Promise<Response> {
  if (!userId || !hash || !SNOWFLAKE_ID.test(userId) || (hash !== DEFAULT_AVATAR && !ICON_HASH.test(hash))) return notFound();
  const isDefault = hash === DEFAULT_AVATAR;
  const ext = isDefault ? 'png' : 'webp';
  // A default avatar has one size; a large custom one is cached beside the small one.
  const sized = large && !isDefault;
  const file = join(dir, `${userId}-${hash}${sized ? `-${LARGE}` : ''}.${ext}`);
  const index = (BigInt(userId) >> SNOWFLAKE_TIMESTAMP_SHIFT) % DEFAULT_AVATAR_COUNT;
  const src = isDefault ? `${DISCORD_CDN}/embed/avatars/${index}.png` : `${DISCORD_CDN}/avatars/${userId}/${hash}.webp?size=${sized ? PROFILE_IMAGE_SIZE_PX : ICON_SIZE_PX}`;
  const status = await fetchOnceToFile(ses, src, file);
  if (status !== null) return upstreamError(status);
  return new Response(await readFile(file), { headers: { 'content-type': STORED_MEDIA_MIME[ext]! } });
}

async function serveAttachment(dir: string, name: string | undefined, range: string | null): Promise<Response> {
  const m = name ? ATTACHMENT_FILE.exec(name) : null;
  if (!m) return notFound();
  const file = join(dir, attachmentShard(m[1]!), name!);
  if (!existsSync(file)) return notFound();
  const { size } = await stat(file);
  const stream = (start: number, end: number): ReadableStream<Uint8Array> => Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return rangedResponse(range, size, STORED_MEDIA_MIME[m[2]!] ?? GENERIC_CONTENT_TYPE, stream);
}
