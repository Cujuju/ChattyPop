import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell, type WebContents } from 'electron';
import { APP_EVENT_CHANNEL, MAIN_INVOKE } from '@shared/contract';
import { attachmentFileName, savedFileName } from '@shared/media';
import { decodePdfSource } from '@shared/htmlPage';
import { htmlToPdf } from '../pdf';
import { copyAttachmentsToFolder, storedExportFile, storedExportPath } from '../media/attachmentExports';
import { attachmentThumb } from '../media/attachmentThumbs';

/** Saves archived attachments and PDF exports through an owner-selected path. Cross-origin media-scheme links navigate instead of downloading and are blocked by window guards. */
export function registerMediaHandlers(attachmentsDir: string, options: { folderRecord?: string; previewsDir?: string } = {}): void {
  let lastFolder: string | undefined;
  const exportedFolders = new WeakMap<WebContents, Set<string>>();
  ipcMain.handle(MAIN_INVOKE.media.saveAttachment, async (e, value: unknown) => {
    const file = storedExportFile(value);
    const name = basename(savedFileName(file));
    const options = { title: 'Save attachment', defaultPath: join(app.getPath('downloads'), name) };
    const parent = BrowserWindow.fromWebContents(e.sender);
    const pick = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (pick.canceled || !pick.filePath) return;
    await copyFile(await storedExportPath(attachmentsDir, file), pick.filePath);
  });
  ipcMain.handle(MAIN_INVOKE.media.saveAttachmentsToFolder, async (e, values: unknown, requestId: unknown) => {
    if (!Array.isArray(values) || !values.length || typeof requestId !== 'string' || !requestId) throw new Error('Not an attachment export.');
    const files = values.map(storedExportFile);
    if (lastFolder === undefined && options.folderRecord) {
      try {
        const stored: unknown = JSON.parse(await readFile(options.folderRecord, 'utf8'));
        if (typeof stored === 'string') lastFolder = stored;
      } catch { /* Missing or unreadable history starts in Downloads. */ }
    }
    const pickOptions = { title: 'Save attachments to folder', defaultPath: lastFolder ?? app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const parent = BrowserWindow.fromWebContents(e.sender);
    const pick = parent ? await dialog.showOpenDialog(parent, pickOptions) : await dialog.showOpenDialog(pickOptions);
    const folder = pick.filePaths[0];
    if (pick.canceled || !folder) return null;
    lastFolder = folder;
    if (options.folderRecord) await writeFile(options.folderRecord, JSON.stringify(folder)).catch(() => undefined);
    const folders = exportedFolders.get(e.sender) ?? new Set<string>();
    folders.add(folder);
    exportedFolders.set(e.sender, folders);
    return copyAttachmentsToFolder(attachmentsDir, files, folder, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send(APP_EVENT_CHANNEL, { type: 'attachment-save-progress', requestId, ...p });
    });
  });
  ipcMain.handle(MAIN_INVOKE.media.showAttachmentFolder, (e, folder: unknown) => {
    if (typeof folder !== 'string' || !exportedFolders.get(e.sender)?.has(folder)) throw new Error('Not an exported folder.');
    shell.showItemInFolder(folder);
  });
  ipcMain.handle(MAIN_INVOKE.media.startFileDrag, async (e, value: unknown) => {
    const file = storedExportFile(value);
    const source = await storedExportPath(attachmentsDir, file);
    const thumb = options.previewsDir ? await attachmentThumb(attachmentsDir, options.previewsDir, file.sha256, attachmentFileName(file)) : null;
    const icon = thumb ? nativeImage.createFromBuffer(thumb.bytes) : await app.getFileIcon(source);
    if (!e.sender.isDestroyed()) e.sender.startDrag({ file: source, icon });
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
