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
const dir = mkdtempSync(join(tmpdir(), 'cp-save-'));
const out = mkdtempSync(join(tmpdir(), 'cp-saved-'));
mkdirSync(join(dir, attachmentShard(HASH)), { recursive: true });
writeFileSync(join(dir, attachmentShard(HASH), attachmentFileName(HASH, 'clip.mov')), 'bytes');
registerMediaHandlers(dir);
const save = (sha256: unknown, filename: unknown) => env.handlers.get(MAIN_INVOKE.media.saveAttachment)!({ sender: {} }, sha256, filename);

beforeEach(() => {
  env.asked = [];
});

describe('saving an attachment', () => {
  it('copies the stored file to the picked path, offering its name in Downloads', async () => {
    env.pick = { canceled: false, filePath: join(out, 'mine.mov') };
    await save(HASH, 'clip.mov');
    expect(env.asked[0]!.defaultPath).toBe(join('C:/Downloads', 'clip.mov'));
    expect(readFileSync(join(out, 'mine.mov'), 'utf8')).toBe('bytes');
  });

  it('refuses a bad hash or name before any dialog, and writes nothing when cancelled', async () => {
    await expect(save('../x', 'clip.mov')).rejects.toThrow(/Not an archived attachment/);
    await expect(save(HASH, '')).rejects.toThrow(/Not an archived attachment/);
    expect(env.asked).toHaveLength(0);
    env.pick = { canceled: true, filePath: join(out, 'never.mov') };
    await save(HASH, 'clip.mov');
    expect(existsSync(join(out, 'never.mov'))).toBe(false);
  });
});
