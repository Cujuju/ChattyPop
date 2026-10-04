import { dialog, type BrowserWindow, type FileFilter } from 'electron';

/** Asks for one folder (a new one may be made); null when cancelled. */
export async function pickFolder(win: BrowserWindow, title: string): Promise<string | null> {
  const pick = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return (!pick.canceled && pick.filePaths[0]) || null;
}

/** Asks for one or more files; empty when cancelled. */
export async function pickFiles(win: BrowserWindow, title: string, filters: FileFilter[]): Promise<string[]> {
  const pick = await dialog.showOpenDialog(win, { title, properties: ['openFile', 'multiSelections'], filters });
  return pick.canceled ? [] : pick.filePaths;
}
