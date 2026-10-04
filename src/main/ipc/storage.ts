import { ipcMain, type BrowserWindow } from 'electron';
import { restartApp } from '../restart';
import { MAIN_INVOKE, type AppEvent } from '@shared/contract';
import { createArchiveKey, deleteArchiveKey } from '../archiveKey';
import type { CoreClient } from '../coreClient';
import { deletePreviousArchive, moveArchive, storageInfo, verifyMovedArchive } from '../storageMove';

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
  ipcMain.handle(storage.info, () => storageInfo());
  // The key is saved before encrypting (a crash between the two leaves a readable key, never a locked archive),
  // and deleted only after decrypting succeeded.
  ipcMain.handle(storage.setEncrypted, async (_e, on: boolean) => {
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
  });
  ipcMain.handle(storage.move, () => moveArchive(win, { stop: stopArchive, emit, restart }));
  ipcMain.handle(storage.deletePrevious, () => deletePreviousArchive(win));
  void verifyMovedArchive(win, core, restart);
}
