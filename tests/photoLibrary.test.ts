// The page's half of the iPhone app's photo library bridge: gated by the `photoLibrary` capability, requests shaped as the app reads them,
// and a picked item fetched once from the app's scheme into a File for the upload path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_ASSET_READ_BYTES, SHELL_CAPABILITIES, SHELL_NATIVE_GLOBAL, SHELL_PHOTOS_HANDLER, SHELL_PHOTOS_PAGE_MAX, type PhotoAccess, type ShellAssetPage, type ShellPhotosRequest } from '@shared/shell';

import { DEFAULT_DEVICE_CHAT_SETTINGS, type DeviceChatSettings } from '@shared/chatSettings';
import { AUDIO_BITRATE, ENCODE_PRESETS, MAX_FRAME_RATE } from '@shared/videoEncode';

const device = vi.hoisted(() => ({ settings: null as DeviceChatSettings | null, cellular: false }));
vi.mock('../src/renderer/src/state/chatSettings', () => ({ deviceChatSettings: () => device.settings }));
vi.mock('../src/renderer/src/state/network', () => ({ onCellular: () => device.cellular }));

// A path import keeps DOM types outside node type checking.
const libraryPath = '../src/renderer/src/phone/photoLibrary';
const library = (await import(libraryPath)) as {
  photoLibraryOffered(): boolean;
  photoAccess(): Promise<PhotoAccess>;
  requestPhotoAccess(): Promise<PhotoAccess>;
  manageLimitedPhotos(): Promise<PhotoAccess>;
  recentPhotos(offset: number, limit?: number): Promise<ShellAssetPage>;
  photoFile(id: string): Promise<File>;
  photoPickerOffered(): boolean;
  filePickerOffered(): boolean;
  pickPhotos(limit: number): Promise<File[]>;
  pickFiles(): Promise<File[]>;
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
  device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, videoQuality: 'best' };
  device.cellular = false;
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

  it("asks the app to shrink a video to the device's send quality, and not for Best", async () => {
    answer = (r) => (r.op === 'export' ? { token: 'T', name: 'a.mp4', type: 'video/mp4', size: 0 } : undefined);
    const exportOf = async (): Promise<ShellPhotosRequest | undefined> => {
      requests = [];
      await library.photoFile('v');
      return requests[0];
    };
    expect(await exportOf()).toEqual({ op: 'export', id: 'v' });
    device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, videoQuality: 'standard' };
    const shrinkOf = (preset: (typeof ENCODE_PRESETS)[keyof typeof ENCODE_PRESETS]) => ({ ...preset, audioBitrate: AUDIO_BITRATE, maxFrameRate: MAX_FRAME_RATE });
    expect(await exportOf()).toEqual({ op: 'export', id: 'v', shrink: shrinkOf(ENCODE_PRESETS.standard) });
    device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, videoQuality: 'best', dataSaving: true };
    device.cellular = true;
    expect(await exportOf()).toEqual({ op: 'export', id: 'v', shrink: shrinkOf(ENCODE_PRESETS.dataSaver) });
  });
});

describe('the system pickers', () => {
  const pickers = [SHELL_CAPABILITIES.photoLibrary, SHELL_CAPABILITIES.photoPicker, SHELL_CAPABILITIES.documentPicker];

  it('are offered only when the app lists each, and never asked for otherwise', async () => {
    expect([library.photoPickerOffered(), library.filePickerOffered()]).toEqual([false, false]);
    await expect(library.pickPhotos(3)).rejects.toThrow();
    await expect(library.pickFiles()).rejects.toThrow();
    expect(requests).toEqual([]);
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: pickers });
    expect([library.photoPickerOffered(), library.filePickerOffered()]).toEqual([true, true]);
  });

  it('read each picked item in the order picked, and nothing on cancel', async () => {
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: pickers });
    const exported = [
      { token: 'A', name: 'a.jpg', type: 'image/jpeg', size: 2 },
      { token: 'B', name: 'b.pdf', type: 'application/pdf', size: 1 },
    ];
    answer = (r) => (r.op === 'pick' || r.op === 'browse' ? exported : r.op === 'read' ? Buffer.from('xy'.slice(0, r.token === 'A' ? 2 : 1)).toString('base64') : undefined);
    expect((await library.pickPhotos(4)).map((f) => [f.name, f.type, f.size])).toEqual([['a.jpg', 'image/jpeg', 2], ['b.pdf', 'application/pdf', 1]]);
    expect(requests.map((r) => r.op)).toEqual(['pick', 'read', 'read']);
    expect(requests[0]).toEqual({ op: 'pick', limit: 4 });
    requests = [];
    expect(await library.pickFiles()).toHaveLength(2);
    expect(requests[0]).toEqual({ op: 'browse' });
    answer = () => [];
    expect(await library.pickPhotos(4)).toEqual([]);
    expect(await library.pickFiles()).toEqual([]);
  });

  it('asks for no picker without room, and shrinks videos as photoFile does', async () => {
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: pickers });
    answer = () => [];
    expect(await library.pickPhotos(0)).toEqual([]);
    expect(requests).toEqual([]);
    device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, videoQuality: 'standard' };
    await library.pickPhotos(1);
    expect(requests).toEqual([{ op: 'pick', limit: 1, shrink: { ...ENCODE_PRESETS.standard, audioBitrate: AUDIO_BITRATE, maxFrameRate: MAX_FRAME_RATE } }]);
  });

  it('release the unread exports when one fails', async () => {
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: pickers });
    const exported = ['A', 'B', 'C'].map((token) => ({ token, name: `${token}.jpg`, type: 'image/jpeg', size: 1 }));
    answer = (r) => (r.op === 'pick' ? exported : r.op === 'read' ? (r.token === 'A' ? Buffer.from('x').toString('base64') : '') : undefined);
    await expect(library.pickPhotos(3)).rejects.toThrow();
    expect(requests.filter((r) => r.op === 'release')).toEqual([
      { op: 'release', token: 'B' },
      { op: 'release', token: 'C' },
    ]);
  });
});
