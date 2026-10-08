// The phone's Photos library through the iPhone app (ShellPhotoLibrary.swift): access, recent items, thumbnails and picked
// items as Files. Only with the app's `photoLibrary` capability; without it, access reads `denied` and nothing is listed.
// Thumbnails are SHELL_ASSET_SCHEME `<img>`s, which the page's CSP must allow in `img-src`. The system photo picker and Files
// browser each have their own capability, and a page without them falls back to `<input type=file>`.
import {
  SHELL_ASSET_READ_BYTES,
  SHELL_CAPABILITIES,
  SHELL_PHOTOS_EVENT,
  SHELL_PHOTOS_HANDLER,
  SHELL_PHOTOS_PAGE_MAX,
  isPhotoAccess,
  shellHas,
  shellThumbUrl,
  type PhotoAccess,
  type ShellAssetExport,
  type ShellAssetPage,
  type ShellCapability,
  type ShellPhotosRequest,
  type ShellVideoShrink,
} from '@shared/shell';
import { AUDIO_BITRATE, ENCODE_PRESETS, MAX_FRAME_RATE, effectiveVideoQualityFor } from '@shared/videoEncode';
import { deviceChatSettings } from '@/state/chatSettings';
import { onCellular } from '@/state/network';

export { shellThumbUrl as photoThumbUrl, type PhotoAccess, type ShellAsset as PhotoAsset, type ShellAssetPage as PhotoPage } from '@shared/shell';

interface PhotosHandler {
  postMessage(request: ShellPhotosRequest): Promise<unknown>;
}

const NO_ACCESS: PhotoAccess = 'denied';

/** The app's handler, when this build lists `capability`. */
const handler = (capability: ShellCapability = SHELL_CAPABILITIES.photoLibrary): PhotosHandler | undefined =>
  shellHas(capability)
    ? (globalThis as { webkit?: { messageHandlers?: Record<string, PhotosHandler | undefined> } }).webkit?.messageHandlers?.[SHELL_PHOTOS_HANDLER]
    : undefined;

async function askAccess(op: 'access' | 'request' | 'manage'): Promise<PhotoAccess> {
  const photos = handler();
  if (!photos) return NO_ACCESS;
  const access = await photos.postMessage({ op });
  if (!isPhotoAccess(access)) throw new Error('The app answered with an unknown photo access.');
  return access;
}

/** Whether this device's app can list photos at all: then the sheet shows the grid. */
export const photoLibraryOffered = (): boolean => shellHas(SHELL_CAPABILITIES.photoLibrary);
/** The access the owner gave, without asking. */
export const photoAccess = (): Promise<PhotoAccess> => askAccess('access');
/** Asks the owner for access if they haven't been asked yet, and returns what they gave. */
export const requestPhotoAccess = (): Promise<PhotoAccess> => askAccess('request');
/** With `limited` access, lets the owner change which photos the app may read; resolves once they're done. */
export const manageLimitedPhotos = (): Promise<PhotoAccess> => askAccess('manage');

/** Up to `limit` photos and videos, newest first, from `offset` on. Rejects without access. */
export async function recentPhotos(offset: number, limit: number = SHELL_PHOTOS_PAGE_MAX): Promise<ShellAssetPage> {
  const photos = handler();
  if (!photos) return { assets: [], total: 0 };
  return (await photos.postMessage({ op: 'recent', offset, limit: Math.min(limit, SHELL_PHOTOS_PAGE_MAX) })) as ShellAssetPage;
}

/** Base64 text as bytes. */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** What the app shrinks a video to before the page reads it: the device's send quality, or nothing for Best. */
function videoShrink(): ShellVideoShrink | undefined {
  const quality = effectiveVideoQualityFor(deviceChatSettings(), onCellular());
  if (quality === 'best') return undefined;
  const { shortSide, videoBitrate } = ENCODE_PRESETS[quality];
  return { shortSide, videoBitrate, audioBitrate: AUDIO_BITRATE, maxFrameRate: MAX_FRAME_RATE };
}

/** Export `exported` read piece by piece, one in flight, into a File; the last read deletes it. A failed read releases it. */
async function readExport(photos: PhotosHandler, { token, name, type, size }: ShellAssetExport): Promise<File> {
  // Each piece joins the Blob as it comes, so the page holds one piece's bytes at a time; WebKit keeps the rest.
  let read = new Blob([]);
  try {
    while (read.size < size) {
      const piece = bytesOf((await photos.postMessage({ op: 'read', token, offset: read.size, length: SHELL_ASSET_READ_BYTES })) as string);
      if (!piece.length) throw new Error('The photo or video ended early.');
      read = new Blob([read, piece]);
    }
  } catch (err) {
    void photos.postMessage({ op: 'release', token }).catch(() => {});
    throw err;
  }
  return new File([read], name, { type });
}

/** Each export in turn as a File. When one fails, the ones not yet read are released. */
async function readExports(photos: PhotosHandler, exported: readonly ShellAssetExport[]): Promise<File[]> {
  const files: File[] = [];
  try {
    for (const item of exported) files.push(await readExport(photos, item));
  } catch (err) {
    for (const { token } of exported.slice(files.length + 1)) void photos.postMessage({ op: 'release', token }).catch(() => {});
    throw err;
  }
  return files;
}

/**
 * Library item `id` as a File for the composer's upload path: the app exports it (HEIC as JPEG, HEVC as H.264, a video shrunk
 * to the device's send quality) to a file, which is read here.
 */
export async function photoFile(id: string): Promise<File> {
  const photos = handler();
  if (!photos) throw new Error('This app version cannot read Photos.');
  const shrink = videoShrink();
  const request: ShellPhotosRequest = shrink ? { op: 'export', id, shrink } : { op: 'export', id };
  return readExport(photos, (await photos.postMessage(request)) as ShellAssetExport);
}

/** Whether this device's app opens the system photo picker: then Photos uses pickPhotos, not `<input type=file>`. */
export const photoPickerOffered = (): boolean => shellHas(SHELL_CAPABILITIES.photoPicker);
/** Whether this device's app opens the system Files browser: then Files uses pickFiles, not `<input type=file>`. */
export const filePickerOffered = (): boolean => shellHas(SHELL_CAPABILITIES.documentPicker);

/**
 * The system photo picker, up to `limit` items, as Files in the order picked; none when the owner cancels. Converted and
 * shrunk as photoFile's are. Needs no library access.
 */
export async function pickPhotos(limit: number): Promise<File[]> {
  const photos = handler(SHELL_CAPABILITIES.photoPicker);
  if (!photos) throw new Error('This app version has no photo picker.');
  if (limit < 1) return [];
  const shrink = videoShrink();
  const request: ShellPhotosRequest = shrink ? { op: 'pick', limit, shrink } : { op: 'pick', limit };
  return readExports(photos, (await photos.postMessage(request)) as ShellAssetExport[]);
}

/** The system Files browser, any number of files, as Files; none when the owner cancels. */
export async function pickFiles(): Promise<File[]> {
  const photos = handler(SHELL_CAPABILITIES.documentPicker);
  if (!photos) throw new Error('This app version has no Files browser.');
  return readExports(photos, (await photos.postMessage({ op: 'browse' })) as ShellAssetExport[]);
}

/** Calls `listener` whenever the readable library changes; returns its removal. */
export function onPhotoLibraryChange(listener: () => void): () => void {
  window.addEventListener(SHELL_PHOTOS_EVENT, listener);
  return () => window.removeEventListener(SHELL_PHOTOS_EVENT, listener);
}
