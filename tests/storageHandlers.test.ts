// Settings → Archive encryption through main: the desktop and a phone may both ask, so changes run one at a time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

const log = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/restart', () => ({ restartApp: () => undefined }));
vi.mock('../src/main/storageMove', () => ({ storageInfo: () => null, moveArchive: () => undefined, deletePreviousArchive: () => undefined, dismissStorageNotice: () => undefined, verifyMovedArchive: async () => undefined }));
vi.mock('../src/main/archiveKey', () => ({
  createArchiveKey: () => (log.push('create'), 'k'),
  deleteArchiveKey: () => void log.push('delete'),
}));

const { registerStorageHandlers } = await import('../src/main/ipc/storage');
const { callMain } = await import('../src/main/ipc/mainCalls');
const { MAIN_INVOKE } = await import('../src/shared/contract');

/** Core as the handler reaches it: its encryption state, a rekey that may wait or fail, and the events main sends. */
function setup(encrypted: boolean, rekey: (key: string | null) => Promise<void> = async () => undefined) {
  const state = { encrypted };
  const emitted: AppEvent[] = [];
  const core = {
    call: vi.fn(async (method: string, key?: string | null) => {
      if (method === 'status') return { encrypted: state.encrypted };
      log.push(key ? 'rekey' : 'decrypt');
      await rekey(key ?? null);
      state.encrypted = key !== null;
    }),
  };
  registerStorageHandlers({ win: {} as never, core: core as never, emit: (e) => void emitted.push(e), stopArchive: async () => undefined });
  const set = (on: unknown): Promise<unknown> => callMain(MAIN_INVOKE.storage.setEncrypted, [on]);
  return { set, emitted, state };
}

describe('archive encryption from main', () => {
  beforeEach(() => void log.splice(0));

  it('runs overlapping changes in order, so decrypting never deletes the key a later encrypt saved', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const { set, emitted } = setup(true, (key) => (key ? Promise.resolve() : first));
    const off = set(false);
    const on = set(true);
    await Promise.resolve();
    release();
    await Promise.all([off, on]);
    expect(log).toEqual(['decrypt', 'delete', 'create', 'rekey']);
    expect(emitted.filter((e) => e.type === 'status-changed')).toHaveLength(2);
    await expect(set('yes')).rejects.toThrow(TypeError);
  });

  it('leaves the key in use alone when asked for the state the archive already has', async () => {
    const { set } = setup(true, () => Promise.reject(new Error('rekey failed')));
    await set(true);
    expect(log).toEqual([]);
  });
});
