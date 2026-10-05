import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { SHA256_HEX, attachmentFileName, attachmentShard } from '@shared/media';

/**
 * Saving an archived attachment where the owner picks. A link's `download` can't do it in a window: the media scheme is
 * another origin than the page, so Chromium navigates instead, which the window's guard refuses.
 */
export function registerMediaHandlers(attachmentsDir: string): void {
  ipcMain.handle(MAIN_INVOKE.media.saveAttachment, async (e, sha256: unknown, filename: unknown) => {
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256) || typeof filename !== 'string' || !filename) throw new Error('Not an archived attachment.');
    const name = basename(filename);
    const options = { title: 'Save attachment', defaultPath: join(app.getPath('downloads'), name) };
    const parent = BrowserWindow.fromWebContents(e.sender);
    const pick = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (pick.canceled || !pick.filePath) return;
    await copyFile(join(attachmentsDir, attachmentShard(sha256), attachmentFileName(sha256, name)), pick.filePath);
  });
}
