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
type CoreState = { encrypted: boolean; reachable: boolean; readFails: boolean; absent: boolean };
function setup(
  encrypted: boolean,
  rekey: (key: string | null, state: CoreState) => Promise<void> = async () => undefined,
  initial: Partial<CoreState> = {},
) {
  const state: CoreState = { encrypted, reachable: true, readFails: false, absent: false, ...initial };
  const emitted: AppEvent[] = [];
  const core = {
    call: vi.fn(async (method: string, key?: string | null) => {
      if (!state.reachable) throw new Error('core exited');
      if (method === 'status') throw new Error('main must read the file, never the cached status');
      if (method === 'archiveEncryption') {
        if (state.readFails) throw new Error('SQLITE_IOERR');
        return state.absent ? 'absent' : state.encrypted ? 'encrypted' : 'plaintext';
      }
      log.push(key ? 'rekey' : 'decrypt');
      await rekey(key ?? null, state);
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

  it('keeps the key when encrypting failed after the file was encrypted', async () => {
    const { set } = setup(false, async (_key, state) => {
      state.encrypted = true;
      throw new Error('journal restore failed');
    });
    await expect(set(true)).rejects.toThrow(/journal restore/);
    expect(log).toEqual(['create', 'rekey']);
  });

  it('deletes a saved key only once the core reports the file plaintext', async () => {
    const failed = setup(false, () => Promise.reject(new Error('rekey failed')));
    await expect(failed.set(true)).rejects.toThrow(/rekey failed/);
    expect(log).toEqual(['create', 'rekey', 'delete']);
    log.splice(0);
    const gone = setup(false, async (_key, state) => {
      state.reachable = false;
      throw new Error('core exited');
    });
    await expect(gone.set(true)).rejects.toThrow(/core exited/);
    expect(log).toEqual(['create', 'rekey']); // state unknown: kept, and openDb ignores a key the plaintext file doesn't need
  });

  it('keeps the key when the file cannot be read after a change, and a retry never replaces it', async () => {
    const { set, state } = setup(false, async (_key, s) => {
      s.encrypted = true;
      s.readFails = true;
      throw new Error('SQLITE_IOERR');
    });
    await expect(set(true)).rejects.toThrow(/SQLITE_IOERR/);
    expect(log).toEqual(['create', 'rekey']);
    await expect(set(true)).rejects.toThrow(/SQLITE_IOERR/); // state unknown: no new key
    state.readFails = false;
    await set(true); // read as encrypted: the key in use stays
    expect(log).toEqual(['create', 'rekey']);
  });

  it('settles no key at startup, and keeps it while the archive file is missing', async () => {
    setup(false); // a plaintext file, perhaps a fallback location: its key may belong to the archive elsewhere
    await new Promise((settled) => setTimeout(settled)); // past any startup core calls
    expect(log).toEqual([]);
    const { set } = setup(true, undefined, { absent: true });
    await expect(set(false)).rejects.toThrow(/missing/);
    expect(log).toEqual([]);
  });

  it('leaves the key in use alone when asked for the state the archive already has', async () => {
    const { set } = setup(true, () => Promise.reject(new Error('rekey failed')));
    await set(true);
    expect(log).toEqual([]);
  });
});
