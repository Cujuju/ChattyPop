import { ipcMain, type BrowserWindow } from 'electron';
import { restartApp } from '../restart';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { createArchiveKey, deleteArchiveKey } from '../archiveKey';
import type { CoreClient } from '../coreClient';
import { deletePreviousArchive, moveArchive, storageInfo, verifyMovedArchive } from '../storageMove';
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
  // The key is saved before encrypting (a crash between the two leaves a readable key, never a locked archive),
  // and deleted only after decrypting succeeded.
  // One change at a time: overlapping calls (the desktop and a phone) must not interleave saving and deleting the key.
  let encrypting: Promise<void> = Promise.resolve();
  const setEncrypted = async (on: boolean): Promise<void> => {
    // Already so: a second client's same request must not replace (and on failure delete) the key in use.
    if ((await core.call('status')).encrypted === on) return;
    if (on) {
      const key = createArchiveKey();
      try {
        await core.call('setEncryption', key);
      } catch (err) {
        deleteArchiveKey();
        throw err;
      }
    } else {
      await core.call('setEncryption', null);
      deleteArchiveKey();
    }
  };
  handleMain(storage.setEncrypted, (on) => {
    if (typeof on !== 'boolean') throw new TypeError('on must be a boolean');
    const run = encrypting.then(() => setEncrypted(on)).finally(() => emit({ type: 'status-changed' }));
    encrypting = run.catch(() => undefined);
    return run;
  });
  ipcMain.handle(storage.move, () => moveArchive(win, { stop: stopArchive, emit, restart }));
  ipcMain.handle(storage.deletePrevious, () => deletePreviousArchive(win));
  void verifyMovedArchive(win, core, restart);
}
