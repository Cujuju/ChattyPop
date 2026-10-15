import { ipcMain, type BrowserWindow } from 'electron';
import { restartApp } from '../restart';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { createArchiveKey, deleteArchiveKey } from '../archiveKey';
import type { CoreClient } from '../coreClient';
import { deletePreviousArchive, dismissStorageNotice, moveArchive, storageInfo, verifyMovedArchive } from '../storageMove';
import { handleMain } from './mainCalls';

export interface StorageDeps {
  win: BrowserWindow;
  core: CoreClient;
  emit(e: AppEvent): void;
  /** Stops downloads and sync writing to the archive and closes it (before a move). */
  stopArchive(): Promise<void>;
}

/** Settings → Archive: location and encryption. Also checks a just-moved archive. */
export function registerStorageHandlers({ win, core, emit, stopArchive }: StorageDeps): void {
  const { storage } = MAIN_INVOKE;
  const restart = (): void => restartApp(win);
  handleMain(storage.info, () => storageInfo());
  // The key is saved before encrypting (a crash between the two leaves a key the plaintext file opens without),
  // and deleted only once a fresh read of the file shows it plaintext: a failed change may have encrypted it anyway.
  // A failed read or an unreachable core leaves the state unknown, so the key stays.
  const settleKey = async (): Promise<void> => {
    if (await core.call('archivePlaintext').catch(() => false)) deleteArchiveKey();
  };
  // One change at a time: overlapping calls (the desktop and a phone) must not interleave saving and deleting the key.
  // The first settle drops a key an interrupted change left unused.
  let encrypting: Promise<void> = settleKey();
  const setEncrypted = async (on: boolean): Promise<void> => {
    // Already so: a second client's same request must not replace (and on failure delete) the key in use.
    if ((await core.call('status')).encrypted === on) return;
    try {
      await core.call('setEncryption', on ? createArchiveKey() : null);
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
