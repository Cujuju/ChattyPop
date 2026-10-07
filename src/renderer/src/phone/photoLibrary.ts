// The phone's Photos library through the iPhone app (ShellPhotoLibrary.swift): access, recent items, thumbnails and picked
// items as Files. Only with the app's `photoLibrary` capability; without it, access reads `denied` and nothing is listed.
// Thumbnails are SHELL_ASSET_SCHEME `<img>`s, which the page's CSP must allow in `img-src`.
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
  type ShellPhotosRequest,
} from '@shared/shell';

export { shellThumbUrl as photoThumbUrl, type PhotoAccess, type ShellAsset as PhotoAsset, type ShellAssetPage as PhotoPage } from '@shared/shell';

interface PhotosHandler {
  postMessage(request: ShellPhotosRequest): Promise<unknown>;
}

const NO_ACCESS: PhotoAccess = 'denied';

/** The app's handler, when this build lists the capability. */
const handler = (): PhotosHandler | undefined =>
  shellHas(SHELL_CAPABILITIES.photoLibrary)
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

/**
 * Library item `id` as a File for the composer's upload path: the app exports it (HEIC as JPEG, HEVC as H.264) to a file, which
 * is read here piece by piece, one in flight; the last read deletes it. A failed read releases it.
 */
export async function photoFile(id: string): Promise<File> {
  const photos = handler();
  if (!photos) throw new Error('This app version cannot read Photos.');
  const { token, name, type, size } = (await photos.postMessage({ op: 'export', id })) as ShellAssetExport;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  try {
    for (let offset = 0; offset < size; ) {
      const piece = bytesOf((await photos.postMessage({ op: 'read', token, offset, length: SHELL_ASSET_READ_BYTES })) as string);
      if (!piece.length) throw new Error('The photo or video ended early.');
      parts.push(piece);
      offset += piece.length;
    }
  } catch (err) {
    void photos.postMessage({ op: 'release', token }).catch(() => {});
    throw err;
  }
  return new File(parts, name, { type });
}

/** Calls `listener` whenever the readable library changes; returns its removal. */
export function onPhotoLibraryChange(listener: () => void): () => void {
  window.addEventListener(SHELL_PHOTOS_EVENT, listener);
  return () => window.removeEventListener(SHELL_PHOTOS_EVENT, listener);
}
