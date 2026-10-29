// Archive keys across encryption changes, moves and deleting the previous copy, through the real handlers, move,
// keyring and database: every archive copy on disk must still open with the stored keys (#274).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

const host = vi.hoisted(() => ({ userData: '', pick: '' }));
/** The fake OS keystore's marker: what it "encrypts" reads back only through it. */
const SEALED = vi.hoisted(() => 'enc:');
vi.mock('electron', () => ({
  app: { getPath: () => host.userData },
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [host.pick] }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'unknown',
    encryptString: (s: string) => Buffer.from(SEALED + s),
    decryptString: (b: Buffer) => b.toString().slice(SEALED.length),
  },
}));
vi.mock('../src/main/restart', () => ({ restartApp: () => undefined }));
/** How many of the next storage-location saves fail as on a full disk. */
const failSaves = vi.hoisted(() => ({ next: 0 }));
vi.mock('../src/main/storageLocation', async (actual) => {
  const real = await actual<typeof import('../src/main/storageLocation')>();
  return {
    ...real,
    saveStorageConfig: (cfg: Parameters<typeof real.saveStorageConfig>[0]) => {
      if (failSaves.next > 0 && failSaves.next--) throw new Error('ENOSPC: no space left on device');
      real.saveStorageConfig(cfg);
    },
  };
});

const { encryptionOnDisk, openDb, rekey } = await import('../src/core/db');
const { archiveKeysFor, bindArchiveCopy, createArchiveKey, startupArchiveKeys } = await import('../src/main/archiveKey');
const { registerStorageHandlers } = await import('../src/main/ipc/storage');
const { callMain } = await import('../src/main/ipc/mainCalls');
const { MAIN_INVOKE, ARCHIVE_DB_FILE } = await import('../src/shared/contract');
const { deletePreviousArchive, moveArchive } = await import('../src/main/storageMove');
const { profilePath, saveStorageConfig, storageConfig } = await import('../src/main/storageLocation');

type Db = ReturnType<typeof openDb>;
const dbFile = (dir: string): string => join(dir, ARCHIVE_DB_FILE);
const secret = (file: string): string => join(host.userData, 'secrets', file);
const legacyKey = (): string | null => (existsSync(secret('archive.key')) ? readFileSync(secret('archive.key'), 'utf8').slice(SEALED.length) : null);
/** Every key still stored: the same list whichever folder asks. */
const storedKeys = (): string[] => archiveKeysFor(host.userData);

/** The app as main starts it: keys from the keyring, core on the configured folder, then the storage handlers. */
function start(opts: { integrity?: string; coreDies?: boolean } = {}): { close(): void; dir: string } {
  const cfg = storageConfig();
  const path = dbFile(cfg.archiveDir);
  let db: Db | null = openDb(path, startupArchiveKeys(cfg, (event, err) => { throw new Error(`${event}: ${String(err)}`); }));
  let dead = false;
  const core = {
    call: async (method: string, arg?: string | null) => {
      if (dead) throw new Error('core exited');
      if (method === 'archiveEncryption') return encryptionOnDisk(path);
      if (method === 'integrityCheck') return opts.integrity ?? String(db!.pragma('quick_check', { simple: true }));
      if (method === 'closeArchive') return void (db!.close(), (db = null));
      dead = opts.coreDies === true; // before its rekey: the key was stored, the file is unchanged
      if (dead) throw new Error('core exited');
      rekey(db!, arg ?? null);
    },
  };
  registerStorageHandlers({ win: {} as never, core: core as never, archiveDir: cfg.archiveDir, emit: () => undefined, stopArchive: () => core.call('closeArchive') as Promise<void> });
  return { close: () => db?.close(), dir: cfg.archiveDir };
}
const settled = (): Promise<void> => new Promise((r) => setTimeout(r)); // the start-up integrity check
async function restart(app: { close(): void }, opts?: Parameters<typeof start>[0]): Promise<ReturnType<typeof start>> {
  app.close();
  const next = start(opts);
  await settled();
  return next;
}
const set = (on: boolean): Promise<unknown> => callMain(MAIN_INVOKE.storage.setEncrypted, [on]);
async function move(app: { close(): void }, to: string): Promise<void> {
  host.pick = to;
  await moveArchive({} as never, { stop: async () => app.close(), emit: () => undefined, restart: () => undefined });
}

/** The invariant: each folder's archive opens with the keys stored for it. */
function expectOpens(...dirs: string[]): void {
  for (const dir of dirs) expect(() => openDb(dbFile(dir), archiveKeysFor(dir)).close(), dir).not.toThrow();
}

beforeEach(() => {
  host.userData = tempDir();
  failSaves.next = 0;
});

describe('archive keys after a move', () => {
  it('keeps the key the retained copy needs through decrypting and encrypting the moved archive', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start();
    await set(true);
    const b = tempDir();
    await move(app, b);
    app = await restart(app);
    await set(false);
    expectOpens(a, b);
    await set(true); // a second key: the first stays for the original
    expectOpens(a, b);
    expect(storedKeys()).toHaveLength(2);
    app.close();
  });

  it('a fallback start (storage.json unreadable) cannot retire the moved archive’s key', async () => {
    saveStorageConfig({ archiveDir: profilePath() }); // the default: the original stays in the profile folder
    let app = start();
    await set(true);
    const b = tempDir();
    await move(app, b);
    app = await restart(app);
    writeFileSync(profilePath('storage.json'), '{torn');
    app = await restart(app); // opens the retained original
    expect(app.dir).toBe(profilePath());
    await set(false);
    await set(true);
    await set(false);
    expectOpens(profilePath(), b);
    app.close();
  });

  it('keeps both copies’ key when the moved copy fails its check and the original is decrypted', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start();
    await set(true);
    const b = tempDir();
    await move(app, b);
    app = await restart(app, { integrity: 'row 5 missing from index' }); // reverts to a, leaving b for inspection
    app = await restart(app);
    expect(app.dir).toBe(a);
    await set(false);
    expectOpens(a, b);
    app.close();
  });

  it('retires a key once no folder that may use it remains, and mirrors the current key for older builds', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start();
    await set(true);
    expect(legacyKey()).toBe(storedKeys()[0]); // an older build opens the archive with its lone key
    await set(false);
    expect(storedKeys()).toEqual([]);
    expect(legacyKey()).toBeNull();

    await set(true);
    const b = tempDir();
    await move(app, b);
    app = await restart(app);
    await set(false);
    expect(storedKeys()).toHaveLength(1); // the original's
    expect(legacyKey()).toBeNull(); // the archive in use is plaintext
    await deletePreviousArchive();
    expect(storedKeys()).toEqual([]);
    app.close();
  });
});

describe('a stop at each step leaves every copy openable', () => {
  it('encrypting: the key is stored before the rekey; one the file never used is retired by a later plaintext read', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start({ coreDies: true });
    await expect(set(true)).rejects.toThrow(/core exited/);
    app = await restart(app);
    expectOpens(a);
    expect(storedKeys()).toHaveLength(1);
    await set(true);
    await set(false);
    expect(storedKeys()).toEqual([]);
    app.close();
  });

  it('moving: the target is bound before the copy, and released only once a failed copy is removed', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start();
    await set(true);
    // Stopped after binding, mid-copy: the half copy needs the key, and the original still opens.
    const half = tempDir();
    bindArchiveCopy(a, half);
    app = await restart(app);
    await set(false);
    expect(storedKeys()).toHaveLength(1);
    await set(true);
    // The location save fails: the copy is removed and its folder released, so only the key in use remains.
    failSaves.next = 1;
    const b = tempDir();
    await move(app, b);
    expect(existsSync(dbFile(b))).toBe(false);
    app = await restart(app);
    expectOpens(a);
    expect(storedKeys()).toHaveLength(2); // the half copy's, and a's
    app.close();
  });

  it('deleting the previous copy: a repeat after a stop between steps finishes the release', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    let app = start();
    await set(true);
    const b = tempDir();
    await move(app, b);
    app = await restart(app);
    await set(false);
    failSaves.next = 1; // files deleted and the key released, then the location save fails
    await expect(deletePreviousArchive()).rejects.toThrow(/ENOSPC/);
    expect(storedKeys()).toEqual([]);
    await deletePreviousArchive();
    expect(storageConfig().previousDir).toBeUndefined();
    app.close();
  });

  it('an unreadable keyring changes nothing: encrypting fails before the rekey', async () => {
    const a = tempDir();
    saveStorageConfig({ archiveDir: a });
    const app = start();
    mkdirSync(join(host.userData, 'secrets'), { recursive: true });
    writeFileSync(secret('archive-keys.json'), `${SEALED}{torn`);
    await expect(set(true)).rejects.toThrow();
    expect(encryptionOnDisk(dbFile(a))).toBe('plaintext');
    expect(readFileSync(secret('archive-keys.json'), 'utf8')).toBe(`${SEALED}{torn`);
    app.close();
  });
});

describe('profiles an older build wrote', () => {
  it('adopts its lone key for the archive and the copy its move kept', async () => {
    const [a, b] = [tempDir(), tempDir()];
    const key = createArchiveKey(a); // the older build's key, then its ring entry removed: only archive.key holds it
    const db = openDb(dbFile(a));
    rekey(db, key);
    db.close();
    rmSync(secret('archive-keys.json'));
    cpSync(dbFile(a), dbFile(b));
    saveStorageConfig({ archiveDir: b, previousDir: a });
    const app = start();
    await set(false);
    expectOpens(a, b);
    expect(legacyKey()).toBeNull();
    expect(storedKeys()).toEqual([key]);
    app.close();
  });
});
