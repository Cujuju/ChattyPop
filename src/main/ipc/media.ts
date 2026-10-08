import { copyFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { SHA256_HEX, attachmentFileName, attachmentShard } from '@shared/media';
import { decodePdfSource } from '@shared/htmlPage';
import { htmlToPdf } from '../pdf';

/** Saves archived attachments and PDF exports through an owner-selected path. Cross-origin media-scheme links navigate instead of downloading and are blocked by window guards. */
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
