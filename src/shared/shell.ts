// The iPhone shell's pairing link, user-agent marker, bundle id and push environment. No imports: capacitor.config.ts loads this through Node's
// own TypeScript stripping, which can't resolve the app's path aliases.
/** `chattypop://pair?origin=<https origin>&code=<digits>`, which the app handles (ios/App/App/ShellViewController.swift). */
export const SHELL_SCHEME = 'chattypop';
export const SHELL_LINK_HOST = 'pair';
export const SHELL_LINK_PARAMS = { origin: 'origin', code: 'code' } as const;
/** The link that pairs the app with the desktop at `origin`: the pairing page's app button and the desktop's app QR. */
export const shellPairLink = (origin: string, code: string): string =>
  `${SHELL_SCHEME}://${SHELL_LINK_HOST}?${new URLSearchParams({ [SHELL_LINK_PARAMS.origin]: origin, [SHELL_LINK_PARAMS.code]: code })}`;
/** Appended to the shell's user agent, so the pairing page knows it's already in the app. */
export const SHELL_USER_AGENT_TOKEN = 'ChattyPopShell';
/** The app's bundle id: capacitor.config.ts's appId, and the topic the desktop's APNs pushes name. */
export const SHELL_BUNDLE_ID = 'com.cujuju.chattypop';
/** APNs environments, as the app's `aps-environment` entitlement names them: Xcode builds use development. */
export const APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];
export const isApnsEnvironment = (v: unknown): v is ApnsEnvironment => (APNS_ENVIRONMENTS as readonly unknown[]).includes(v);
/** Global the app sets before the page loads (ShellViewController.swift): `{ apsEnvironment: ApnsEnvironment, capabilities: ShellCapability[] }`. */
export const SHELL_NATIVE_GLOBAL = 'chattyPopShell';
/**
 * Native features an app build can have, as its SHELL_NATIVE_GLOBAL `capabilities` lists them. The page is served live from the PC,
 * so it can be newer than the installed app: it offers a native feature only when the app lists it (shellHas).
 */
export const SHELL_CAPABILITIES = {
  /** The camera through `<input capture>`: the app declares camera and microphone use. */
  camera: 'camera',
  /** SHELL_SAVE_MEDIA_HANDLER. */
  saveMedia: 'saveMedia',
  /** SHELL_NETWORK_HANDLER and SHELL_NETWORK_EVENT. */
  network: 'network',
  /** SHELL_PHOTOS_HANDLER, SHELL_PHOTOS_EVENT and SHELL_ASSET_SCHEME. */
  photoLibrary: 'photoLibrary',
} as const;
export type ShellCapability = (typeof SHELL_CAPABILITIES)[keyof typeof SHELL_CAPABILITIES];
const CAPABILITY_NAMES: readonly string[] = Object.values(SHELL_CAPABILITIES);
/** The capabilities `shell` (by default the app's SHELL_NATIVE_GLOBAL) lists. No global, no array, or a browser → none. Unknown names are dropped. */
export function shellCapabilities(shell: unknown = (globalThis as Record<string, unknown>)[SHELL_NATIVE_GLOBAL]): ReadonlySet<ShellCapability> {
  const listed = typeof shell === 'object' && shell !== null ? (shell as { capabilities?: unknown }).capabilities : undefined;
  if (!Array.isArray(listed)) return new Set();
  return new Set(listed.filter((name): name is ShellCapability => typeof name === 'string' && CAPABILITY_NAMES.includes(name)));
}
/** Whether the installed app has `capability`. Every native feature the page uses is gated through this. */
export const shellHas = (capability: ShellCapability, shell?: unknown): boolean =>
  (shell === undefined ? shellCapabilities() : shellCapabilities(shell)).has(capability);
/** Custom properties the app sets on `<html>` as the keyboard moves (ShellViewController.swift; the theme's sizes.css reads them). */
export const SHELL_KEYBOARD_PROPERTIES = { inset: '--cp-keyboard-inset', duration: '--cp-keyboard-duration' } as const;
/** Window CustomEvent the app dispatches on each network change and in reply to SHELL_NETWORK_HANDLER, detail a ShellNetworkDetail (state/network.ts). */
export const SHELL_NETWORK_EVENT = 'cp-shell-network';
/** Native script message handler the page posts `{}` to for the current SHELL_NETWORK_EVENT. */
export const SHELL_NETWORK_HANDLER = 'shellNetwork';
export interface ShellNetworkDetail {
  cellular: boolean;
}
export const isShellNetworkDetail = (v: unknown): v is ShellNetworkDetail =>
  typeof v === 'object' && v !== null && typeof (v as { cellular?: unknown }).cellular === 'boolean';
/** The app's handler that saves a camera capture to Photos (ShellMediaSaver.swift). Its postMessage resolves once a piece is written; the last piece's once saved. */
export const SHELL_SAVE_MEDIA_HANDLER = 'shellSaveMedia';
/** One piece of a capture sent to SHELL_SAVE_MEDIA_HANDLER. Pieces go in order from index 0; a new index 0 abandons any unfinished capture. */
export interface ShellMediaPiece {
  /** Names the capture; every piece of it carries the same one. */
  id: string;
  index: number;
  last: boolean;
  /** The capture's MIME type, e.g. `image/jpeg`, `video/quicktime`. */
  type: string;
  /** This piece's bytes, base64. */
  data: string;
}

/** The app's photo library handler (ShellPhotoLibrary.swift). Each postMessage takes a ShellPhotosRequest and resolves to its reply. */
export const SHELL_PHOTOS_HANDLER = 'shellPhotos';
/** Window event the app dispatches when the library, or the part of it the app may read, changes. No detail. */
export const SHELL_PHOTOS_EVENT = 'cp-shell-photos';
/**
 * The library access the owner gave: `full`, `limited` (only the photos they chose), `denied` (also restricted by the device),
 * or `undetermined` (not yet asked).
 */
export const PHOTO_ACCESS = ['full', 'limited', 'denied', 'undetermined'] as const;
export type PhotoAccess = (typeof PHOTO_ACCESS)[number];
export const isPhotoAccess = (v: unknown): v is PhotoAccess => (PHOTO_ACCESS as readonly unknown[]).includes(v);
/** Library item kinds the app lists. */
export const SHELL_ASSET_KINDS = ['photo', 'video'] as const;
export type ShellAssetKind = (typeof SHELL_ASSET_KINDS)[number];
/** One library item: PhotoKit's local identifier, its kind and, for a video, its length in seconds (0 for a photo). */
export interface ShellAsset {
  id: string;
  kind: ShellAssetKind;
  duration: number;
}
/** A page of the library, newest first, and how many items it holds in all. */
export interface ShellAssetPage {
  assets: ShellAsset[];
  total: number;
}
/** An exported item, read with `read` requests: the app's name for its file, then the item's file name, MIME type and size in bytes. */
export interface ShellAssetExport {
  token: string;
  name: string;
  type: string;
  size: number;
}
/**
 * Messages to SHELL_PHOTOS_HANDLER and what each resolves to:
 * - `access`: PhotoAccess, without asking.
 * - `request`: PhotoAccess, asking the owner first if not yet asked.
 * - `manage`: PhotoAccess, after the owner changes which photos a `limited` app may read.
 * - `recent`: a ShellAssetPage of photos and videos, newest first, `offset` items in, at most `limit` (SHELL_PHOTOS_PAGE_MAX).
 * - `export`: a ShellAssetExport of item `id`, HEIC as JPEG and HEVC as H.264, written to a file in the app. With `shrink`, a
 *   video is re-encoded to it unless it's an unedited H.264 original already within its size. WebKit holds the page's File in
 *   memory (measured on an iPhone 17 Pro Max: a 450 MB video added about 480 MB to the page), so a video is cut down first.
 * - `read`: base64 of up to `length` (SHELL_ASSET_READ_BYTES at most) bytes of export `token` from `offset`. The read that reaches
 *   its end deletes the file. The bytes come this way because WebKit blocks an https page's fetch from an app scheme as mixed content.
 * - `release`: deletes export `token` unread. A relaunch deletes every export.
 */
export type ShellPhotosRequest =
  | { op: 'access' }
  | { op: 'request' }
  | { op: 'manage' }
  | { op: 'recent'; offset: number; limit: number }
  | { op: 'export'; id: string; shrink?: ShellVideoShrink }
  | { op: 'read'; token: string; offset: number; length: number }
  | { op: 'release'; token: string };
/** A video export's target (ShellVideoShrinker.swift): the shorter side and video rate of a page encode preset (EncodePreset). */
export interface ShellVideoShrink {
  /** The output's shorter side, px; a smaller video keeps its size. */
  shortSide: number;
  /** Video bitrate at the full shorter side, bit/s, scaled down by area below it. */
  videoBitrate: number;
  /** AAC bitrate, bit/s. */
  audioBitrate: number;
  /** Frames per second at most. */
  maxFrameRate: number;
}
/** The most items one `recent` request returns. */
export const SHELL_PHOTOS_PAGE_MAX = 200;
/** The most bytes one `read` returns: each is copied as base64 text in the app and the page, so this bounds both (about 5.6 MB of text). */
export const SHELL_ASSET_READ_BYTES = 4 * 1024 * 1024;
/**
 * URL scheme the app serves library thumbnails on, to the paired page only. An `<img>` may load it (WebKit allows passive mixed
 * content, with a console warning); fetch may not. The page's CSP must list it in `img-src`.
 */
export const SHELL_ASSET_SCHEME = 'chattypop-asset';
/** SHELL_ASSET_SCHEME hosts: `thumb/<id>?px=<side>` is a square JPEG thumbnail. */
export const SHELL_ASSET_HOSTS = { thumb: 'thumb' } as const;
/** Query parameter naming a thumbnail's side in device pixels. */
export const SHELL_THUMB_SIZE_PARAM = 'px';
/** The largest thumbnail side the app serves, in device pixels. */
export const SHELL_THUMB_PX_MAX = 1024;
/** A square thumbnail of item `id`, `px` device pixels a side (clamped to 1…SHELL_THUMB_PX_MAX), for an `<img>`. */
export const shellThumbUrl = (id: string, px: number): string =>
  `${SHELL_ASSET_SCHEME}://${SHELL_ASSET_HOSTS.thumb}/${encodeURIComponent(id)}?${SHELL_THUMB_SIZE_PARAM}=${Math.min(SHELL_THUMB_PX_MAX, Math.max(1, Math.round(px)))}`;
