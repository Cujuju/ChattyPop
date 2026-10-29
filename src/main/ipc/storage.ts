import { ipcMain, type BrowserWindow } from 'electron';
import { restartApp } from '../restart';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { createArchiveKey, releasePlaintextArchive } from '../archiveKey';
import type { CoreClient } from '../coreClient';
import { deletePreviousArchive, dismissStorageNotice, moveArchive, storageInfo, verifyMovedArchive } from '../storageMove';
import { handleMain } from './mainCalls';

export interface StorageDeps {
  win: BrowserWindow;
  core: CoreClient;
  /** The folder core opened the archive in: keys are bound to it, not to whatever storage.json says now. */
  archiveDir: string;
  emit(e: AppEvent): void;
  /** Stops downloads and sync writing to the archive and closes it (before a move). */
  stopArchive(): Promise<void>;
}

/** Settings → Archive: location and encryption. Also checks a just-moved archive. */
export function registerStorageHandlers({ win, core, archiveDir, emit, stopArchive }: StorageDeps): void {
  const { storage } = MAIN_INVOKE;
  const restart = (): void => restartApp(win);
  handleMain(storage.info, () => storageInfo());
  // A key is stored, bound to this folder, before encrypting (a crash between leaves a key the plaintext file opens without).
  // The folder is released only once a fresh read of an existing file shows it plaintext: a failed change may have encrypted it.
  // A missing file, a failed read or an unreachable core leaves the state unknown, so the binding stays.
  const settleKey = async (): Promise<void> => {
    if ((await core.call('archiveEncryption').catch(() => null)) === 'plaintext') releasePlaintextArchive(archiveDir);
  };
  // One change at a time: overlapping calls (the desktop and a phone) must not interleave storing and releasing keys.
  // Nothing settles at startup: a key a crash left unused is released once a later change leaves the file plaintext.
  let encrypting: Promise<void> = Promise.resolve();
  const setEncrypted = async (on: boolean): Promise<void> => {
    // Read fresh, never from status: the request is weighed against the file itself.
    const state = await core.call('archiveEncryption');
    if (state === 'absent') throw new Error('The archive file is missing, so its encryption cannot be changed.');
    // Already so: a second client's same request must not rekey the file or add a key.
    if ((state === 'encrypted') === on) return;
    try {
      await core.call('setEncryption', on ? createArchiveKey(archiveDir) : null);
    } finally {
      await settleKey();
    }
  };
  handleMain(storage.setEncrypted, (on) => {
    if (typeof on !== 'boolean') throw new TypeError('on must be a boolean');
    const run = encrypting.then(() => setEncrypted(on)).finally(() => emit({ type: 'status-changed' }));
    encrypting = run.catch(() => undefined);
    return run;
  });
  ipcMain.handle(storage.move, () => moveArchive(win, { stop: stopArchive, emit, restart }));
  handleMain(storage.deletePrevious, () => deletePreviousArchive());
  handleMain(storage.dismissNotice, () => dismissStorageNotice());
  void verifyMovedArchive(core, restart);
}
