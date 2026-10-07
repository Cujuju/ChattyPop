// Settings → Archive encryption through main: the desktop and a phone may both ask, so changes run one at a time.
import { describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/restart', () => ({ restartApp: () => undefined }));
vi.mock('../src/main/storageMove', () => ({ storageInfo: () => null, moveArchive: () => undefined, deletePreviousArchive: () => undefined, verifyMovedArchive: async () => undefined }));
vi.mock('../src/main/archiveKey', () => ({
  createArchiveKey: () => (log.push('create'), 'k'),
  deleteArchiveKey: () => void log.push('delete'),
}));

const { registerStorageHandlers } = await import('../src/main/ipc/storage');
const { callMain } = await import('../src/main/ipc/mainCalls');
const { MAIN_INVOKE } = await import('../src/shared/contract');

describe('archive encryption from main', () => {
  it('runs overlapping changes in order, so decrypting never deletes the key a later encrypt saved', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const core = {
      call: vi.fn(async (_m: string, key: string | null) => {
        log.push(key ? 'rekey' : 'decrypt');
        if (!key) await first;
      }),
    };
    registerStorageHandlers({ win: {} as never, core: core as never, emit: () => undefined, stopArchive: async () => undefined });
    const off = callMain(MAIN_INVOKE.storage.setEncrypted, [false]);
    const on = callMain(MAIN_INVOKE.storage.setEncrypted, [true]);
    await Promise.resolve();
    release();
    await Promise.all([off, on]);
    expect(log).toEqual(['decrypt', 'delete', 'create', 'rekey']);
    await expect(callMain(MAIN_INVOKE.storage.setEncrypted, ['yes'])).rejects.toThrow(TypeError);
  });
});
