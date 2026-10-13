import { copyFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { SHA256_HEX, SAFE_EXT, attachmentFileName, attachmentShard, savedFileName, type StoredFile } from '@shared/media';
import { decodePdfSource } from '@shared/htmlPage';
import { htmlToPdf } from '../pdf';

/** Saves archived attachments and PDF exports through an owner-selected path. Cross-origin media-scheme links navigate instead of downloading and are blocked by window guards. */
export function registerMediaHandlers(attachmentsDir: string): void {
  ipcMain.handle(MAIN_INVOKE.media.saveAttachment, async (e, value: unknown) => {
    const f = value as Partial<StoredFile> | null;
    if (!f || typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256) || typeof f.filename !== 'string' || !f.filename
      || !(f.storedExt === null || (typeof f.storedExt === 'string' && SAFE_EXT.test(f.storedExt))))
      throw new Error('Not an archived attachment.');
    const file: StoredFile = { sha256: f.sha256, filename: f.filename, storedExt: f.storedExt };
    const name = basename(savedFileName(file));
    const options = { title: 'Save attachment', defaultPath: join(app.getPath('downloads'), name) };
    const parent = BrowserWindow.fromWebContents(e.sender);
    const pick = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (pick.canceled || !pick.filePath) return;
    await copyFile(join(attachmentsDir, attachmentShard(file.sha256), attachmentFileName(file)), pick.filePath);
  });
  ipcMain.handle(MAIN_INVOKE.media.savePdf, async (e, page: unknown) => {
    const source = decodePdfSource(page);
    const fileName = (page as { fileName?: unknown }).fileName;
    const name = typeof fileName === 'string' && fileName ? basename(fileName) : FALLBACK_PDF_NAME;
    const options = { title: 'Save PDF', defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const parent = BrowserWindow.fromWebContents(e.sender);
    const pick = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (pick.canceled || !pick.filePath) return;
    await writeFile(pick.filePath, await htmlToPdf(source));
  });
}

const FALLBACK_PDF_NAME = 'export.pdf';
