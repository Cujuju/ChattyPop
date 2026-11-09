// Closes made in code, told from the window's own close command: only the owner's command may hide a window to the tray.
import type { BrowserWindow } from 'electron';

const fromOwner = new WeakSet<BrowserWindow>();

/** The page close button has the same intent as the system close command. */
export function closeFromOwner(win: BrowserWindow): void {
  fromOwner.add(win);
  win.close();
}
export const takeOwnerClose = (win: BrowserWindow): boolean => fromOwner.delete(win);

const fromCode = new WeakSet<BrowserWindow>();

/** Closes `win` from code (the tray's Quit, a restart, a repeated close), so it quits rather than going to the tray. */
export function closeFromCode(win: BrowserWindow): void {
  fromCode.add(win);
  win.close();
}

/** Whether the close now being handled was made by closeFromCode; read once per close. */
export const takeCodeClose = (win: BrowserWindow): boolean => fromCode.delete(win);
