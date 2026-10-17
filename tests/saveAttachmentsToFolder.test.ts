import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENT_CHANNEL, MAIN_INVOKE } from '@shared/contract';
import { attachmentFileName, attachmentShard, type StoredFile } from '@shared/media';
import { phoneMayCallMain } from '@shared/phone';
import { remoteAppEvent, remoteMayCallMain } from '@shared/remote';

const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  pick: { canceled: false, filePaths: [] as string[] },
  asked: [] as { defaultPath: string }[],
  reveal: vi.fn(), icon: {},
  thumbnail: null as { bytes: Buffer; type: string } | null,
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/Downloads', getFileIcon: async () => env.icon },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async (options: { defaultPath: string }) => { env.asked.push(options); return env.pick; } },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
  nativeImage: { createFromBuffer: () => env.icon },
  shell: { showItemInFolder: env.reveal },
}));
vi.mock('../src/main/media/attachmentThumbs', () => ({ attachmentThumb: async () => env.thumbnail }));

const { registerMediaHandlers } = await import('../src/main/ipc/media');
const FILE: StoredFile = { sha256: 'a'.repeat(64), filename: 'photo.png', storedExt: null };
let root: string;
let store: string;
let output: string;
let record: string;
let sender: { isDestroyed(): boolean; send: ReturnType<typeof vi.fn>; startDrag: ReturnType<typeof vi.fn> };
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender }, ...args);
const save = (files: unknown = [FILE]) => invoke(MAIN_INVOKE.media.saveAttachmentsToFolder, files, 'export-1');
function seed(file = FILE, bytes = 'image'): void {
  mkdirSync(join(store, attachmentShard(file.sha256)), { recursive: true });
  writeFileSync(join(store, attachmentShard(file.sha256), attachmentFileName(file)), bytes);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-folder-'));
  store = join(root, 'store'); output = join(root, 'output'); record = join(root, 'last-folder.json');
  mkdirSync(store); mkdirSync(output); seed();
  sender = { isDestroyed: () => false, send: vi.fn(), startDrag: vi.fn() };
  env.pick = { canceled: false, filePaths: [output] }; env.asked = []; env.reveal.mockClear(); env.thumbnail = null;
  registerMediaHandlers(store, { folderRecord: record, previewsDir: join(root, 'previews') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('save selected attachments to a folder', () => {
  it('copies original names, deduplicates existing and selected collisions, and emits request-scoped progress', async () => {
    writeFileSync(join(output, 'photo.png'), 'existing');
    expect(await save([FILE, FILE])).toEqual({ saved: 2, failed: 0, folder: output });
    expect(readFileSync(join(output, 'photo.png'), 'utf8')).toBe('existing');
    expect(readFileSync(join(output, 'photo (2).png'), 'utf8')).toBe('image');
    expect(readFileSync(join(output, 'photo (3).png'), 'utf8')).toBe('image');
    expect(sender.send.mock.calls).toEqual([
      [APP_EVENT_CHANNEL, { type: 'attachment-save-progress', requestId: 'export-1', done: 1, total: 2 }],
      [APP_EVENT_CHANNEL, { type: 'attachment-save-progress', requestId: 'export-1', done: 2, total: 2 }],
    ]);
  });

  it('keeps the stored extension after compression and makes portable leaf filenames', async () => {
    const compressed = { ...FILE, filename: '..\\..\\movie.mov', storedExt: 'mp4' };
    const deviceName = { ...FILE, filename: 'NUL.png' };
    seed(compressed, 'video');
    expect(await save([compressed, deviceName])).toMatchObject({ saved: 2, failed: 0 });
    expect(readdirSync(output).sort()).toEqual(['_NUL.png', 'movie.mp4']);
    expect(readFileSync(join(output, 'movie.mp4'), 'utf8')).toBe('video');
  });

  it('validates every stored name before showing a dialog', async () => {
    for (const bad of [null, { ...FILE, sha256: '../escape' }, { ...FILE, sha256: 'A'.repeat(64) }, { ...FILE, filename: '' },
      { ...FILE, filename: 'bad\0name.png' }, ...[undefined, '../mp4', 'MP4', '', '123456789', 1].map((storedExt) => ({ ...FILE, storedExt }))]) {
      await expect(save([FILE, bad])).rejects.toThrow(/Not an archived attachment/);
    }
    await expect(save([])).rejects.toThrow(/export/);
    await expect(save({})).rejects.toThrow(/export/);
    expect(env.asked).toEqual([]);
    expect(readdirSync(output)).toEqual([]);
  });

  it('returns null on cancellation or an empty picker result without copies, history or progress', async () => {
    env.pick.canceled = true;
    expect(await save([FILE, FILE])).toBeNull();
    env.pick = { canceled: false, filePaths: [] };
    expect(await save()).toBeNull();
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(output)).toEqual([]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('continues after an unavailable source, reports failed copies, and skips progress for one file', async () => {
    const missing = { ...FILE, sha256: 'b'.repeat(64) };
    expect(await save([missing, FILE])).toEqual({ saved: 1, failed: 1, folder: output });
    expect(sender.send.mock.calls.at(-1)?.[1]).toMatchObject({ done: 2, total: 2 });
    sender.send.mockClear();
    expect(await save([missing])).toMatchObject({ saved: 0, failed: 1 });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('remembers the picked folder across handler registrations, and reveals only this window’s exports', async () => {
    await save();
    expect(env.asked[0]?.defaultPath).toBe('C:/Downloads');
    expect(JSON.parse(readFileSync(record, 'utf8'))).toBe(output);
    await invoke(MAIN_INVOKE.media.showAttachmentFolder, output);
    expect(env.reveal).toHaveBeenCalledWith(output);
    expect(() => invoke(MAIN_INVOKE.media.showAttachmentFolder, root)).toThrow(/exported folder/);
    registerMediaHandlers(store, { folderRecord: record });
    expect(() => invoke(MAIN_INVOKE.media.showAttachmentFolder, output)).toThrow(/exported folder/);
    await save();
    expect(env.asked[1]?.defaultPath).toBe(output);
  });

  it('never reads a symlinked shard outside the stored-attachments root', async () => {
    const escaped = { ...FILE, sha256: 'c'.repeat(64) };
    const outside = join(root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, attachmentFileName(escaped)), 'private');
    symlinkSync(outside, join(store, attachmentShard(escaped.sha256)), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await save([escaped, FILE])).toMatchObject({ saved: 1, failed: 1 });
    expect(readFileSync(join(output, 'photo.png'), 'utf8')).toBe('image');
    await expect(invoke(MAIN_INVOKE.media.startFileDrag, escaped)).rejects.toThrow(/stored attachment path/);
  });

  it('starts a native drag with the stored path and a thumbnail icon, validating the same source', async () => {
    env.thumbnail = { bytes: Buffer.from('thumbnail'), type: 'image/jpeg' };
    await invoke(MAIN_INVOKE.media.startFileDrag, FILE);
    expect(sender.startDrag).toHaveBeenCalledWith({ file: expect.stringContaining(attachmentFileName(FILE)), icon: env.icon });
    await expect(invoke(MAIN_INVOKE.media.startFileDrag, { ...FILE, storedExt: '../txt' })).rejects.toThrow(/archived attachment/);
    expect(sender.startDrag).toHaveBeenCalledTimes(1);
  });

  it('refuses disk exports, reveal and native drag on phone and remote transports', () => {
    for (const method of ['saveAttachmentsToFolder', 'showAttachmentFolder', 'startFileDrag'] as const) {
      expect(phoneMayCallMain(MAIN_INVOKE.media[method])).toBe(false);
      expect(remoteMayCallMain(MAIN_INVOKE.media[method])).toBe(false);
    }
    expect(remoteAppEvent({ type: 'attachment-save-progress', requestId: 'x', done: 1, total: 2 })).toBeNull();
  });
});
