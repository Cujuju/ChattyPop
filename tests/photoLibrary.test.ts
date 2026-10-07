// The page's half of the iPhone app's photo library bridge: gated by the `photoLibrary` capability, requests shaped as the app reads them,
// and a picked item fetched once from the app's scheme into a File for the upload path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_ASSET_READ_BYTES, SHELL_CAPABILITIES, SHELL_NATIVE_GLOBAL, SHELL_PHOTOS_HANDLER, SHELL_PHOTOS_PAGE_MAX, type PhotoAccess, type ShellAssetPage, type ShellPhotosRequest } from '@shared/shell';

// A path import keeps DOM types outside node type checking.
const libraryPath = '../src/renderer/src/phone/photoLibrary';
const library = (await import(libraryPath)) as {
  photoLibraryOffered(): boolean;
  photoAccess(): Promise<PhotoAccess>;
  requestPhotoAccess(): Promise<PhotoAccess>;
  manageLimitedPhotos(): Promise<PhotoAccess>;
  recentPhotos(offset: number, limit?: number): Promise<ShellAssetPage>;
  photoFile(id: string): Promise<File>;
};

/** Byte pattern period: prime, so piece boundaries never line up with it. */
const BYTE_PERIOD = 251;

let requests: ShellPhotosRequest[];
let answer: (request: ShellPhotosRequest) => unknown;
const postMessage = (request: ShellPhotosRequest): Promise<unknown> => {
  requests.push(request);
  return Promise.resolve(answer(request));
};

beforeEach(() => {
  requests = [];
  answer = () => 'full';
  vi.stubGlobal('webkit', { messageHandlers: { [SHELL_PHOTOS_HANDLER]: { postMessage } } });
  vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: [SHELL_CAPABILITIES.photoLibrary] });
});
afterEach(() => vi.unstubAllGlobals());

describe('without the photoLibrary capability', () => {
  it('offers nothing and never asks the app, though it has the handler', async () => {
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: [SHELL_CAPABILITIES.camera] });
    expect(library.photoLibraryOffered()).toBe(false);
    expect(await library.photoAccess()).toBe('denied');
    expect(await library.requestPhotoAccess()).toBe('denied');
    expect(await library.recentPhotos(0)).toEqual({ assets: [], total: 0 });
    await expect(library.photoFile('x')).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

describe('with it', () => {
  it('asks for access, and refuses an answer it does not know', async () => {
    expect(library.photoLibraryOffered()).toBe(true);
    answer = () => 'limited';
    expect(await library.requestPhotoAccess()).toBe('limited');
    expect(await library.manageLimitedPhotos()).toBe('limited');
    answer = () => 'sure';
    await expect(library.photoAccess()).rejects.toThrow();
    expect(requests).toEqual([{ op: 'request' }, { op: 'manage' }, { op: 'access' }]);
  });

  it('pages recent items, never past the app\'s page limit', async () => {
    const page = { assets: [{ id: 'a/L0/001', kind: 'video', duration: 3.5 }], total: 1 };
    answer = () => page;
    expect(await library.recentPhotos(30, 30)).toEqual(page);
    await library.recentPhotos(0, SHELL_PHOTOS_PAGE_MAX + 1);
    expect(requests).toEqual([
      { op: 'recent', offset: 30, limit: 30 },
      { op: 'recent', offset: 0, limit: SHELL_PHOTOS_PAGE_MAX },
    ]);
  });

  it('reads a picked item in order, one piece at a time, into a File', async () => {
    const bytes = Uint8Array.from({ length: 2 * SHELL_ASSET_READ_BYTES + 3 }, (_, i) => i % BYTE_PERIOD);
    answer = (r) => {
      if (r.op === 'export') return { token: 'T', name: 'IMG_1.mp4', type: 'video/mp4', size: bytes.length };
      if (r.op === 'read') return Buffer.from(bytes.subarray(r.offset, r.offset + r.length)).toString('base64');
      return undefined;
    };
    const file = await library.photoFile('a/L0/001');
    expect(requests).toEqual([
      { op: 'export', id: 'a/L0/001' },
      ...[0, 1, 2].map((i) => ({ op: 'read', token: 'T', offset: i * SHELL_ASSET_READ_BYTES, length: SHELL_ASSET_READ_BYTES })),
    ]);
    expect([file.name, file.type, file.size]).toEqual(['IMG_1.mp4', 'video/mp4', bytes.length]);
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  it('releases the export when a read fails or comes up short', async () => {
    for (const read of [() => Promise.reject(new Error('gone')), () => '']) {
      requests = [];
      answer = (r) => (r.op === 'export' ? { token: 'T', name: 'a.jpg', type: 'image/jpeg', size: 4 } : r.op === 'read' ? read() : undefined);
      await expect(library.photoFile('a')).rejects.toThrow();
      expect(requests.at(-1)).toEqual({ op: 'release', token: 'T' });
    }
  });

  it('reads an empty export as an empty File, without reading', async () => {
    answer = () => ({ token: 'T', name: 'a.jpg', type: 'image/jpeg', size: 0 });
    expect((await library.photoFile('a')).size).toBe(0);
    expect(requests.map((r) => r.op)).toEqual(['export']);
  });
});
