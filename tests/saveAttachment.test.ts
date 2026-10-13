// Saving attachments copies stored files to selected paths using their filenames. Invalid hashes fail before dialogs; cancellation writes nothing.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentFileName, attachmentShard } from '@shared/media';

const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  pick: { canceled: false, filePath: '' } as { canceled: boolean; filePath?: string },
  asked: [] as { defaultPath?: string }[],
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/Downloads' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showSaveDialog: async (options: { defaultPath?: string }) => {
      env.asked.push(options);
      return env.pick;
    },
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => void env.handlers.set(channel, fn) },
}));

const { registerMediaHandlers } = await import('../src/main/ipc/media');
const { MAIN_INVOKE } = await import('../src/shared/contract');

const HASH = 'a'.repeat(64);
const FILE = { sha256: HASH, filename: 'clip.mov', storedExt: null };
const dir = mkdtempSync(join(tmpdir(), 'cp-save-'));
const out = mkdtempSync(join(tmpdir(), 'cp-saved-'));
mkdirSync(join(dir, attachmentShard(HASH)), { recursive: true });
writeFileSync(join(dir, attachmentShard(HASH), attachmentFileName(FILE)), 'bytes');
writeFileSync(join(dir, attachmentShard(HASH), attachmentFileName({ ...FILE, storedExt: 'mp4' })), 'smaller');
registerMediaHandlers(dir);
const save = (file: unknown) => env.handlers.get(MAIN_INVOKE.media.saveAttachment)!({ sender: {} }, file);

beforeEach(() => {
  env.asked = [];
});

describe('saving an attachment', () => {
  it('copies the stored file to the picked path, offering its name in Downloads', async () => {
    env.pick = { canceled: false, filePath: join(out, 'mine.mov') };
    await save(FILE);
    expect(env.asked[0]!.defaultPath).toBe(join('C:/Downloads', 'clip.mov'));
    expect(readFileSync(join(out, 'mine.mov'), 'utf8')).toBe('bytes');
  });

  it('refuses a bad hash or name before any dialog, and writes nothing when cancelled', async () => {
    await expect(save({ ...FILE, sha256: '../x' })).rejects.toThrow(/Not an archived attachment/);
    await expect(save({ ...FILE, filename: '' })).rejects.toThrow(/Not an archived attachment/);
    for (const storedExt of [undefined, '../mp4', 'MP4', '', '123456789', 1])
      await expect(save({ ...FILE, storedExt })).rejects.toThrow(/Not an archived attachment/);
    await expect(save(null)).rejects.toThrow(/Not an archived attachment/);
    expect(env.asked).toHaveLength(0);
    env.pick = { canceled: true, filePath: join(out, 'never.mov') };
    await save(FILE);
    expect(existsSync(join(out, 'never.mov'))).toBe(false);
  });

  it('copies a re-encoded file and offers the stored extension in Downloads', async () => {
    env.pick = { canceled: false, filePath: join(out, 'mine.mp4') };
    await save({ ...FILE, storedExt: 'mp4' });
    expect(env.asked[0]!.defaultPath).toBe(join('C:/Downloads', 'clip.mp4'));
    expect(readFileSync(join(out, 'mine.mp4'), 'utf8')).toBe('smaller');
  });
});
