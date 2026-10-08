// A renderer window's unsaved edits (renderer state/unsavedChanges): main holds its close or reload, the window asks
// the owner in its own themed dialog, and Discard repeats what was held.
import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { APP_EVENT_CHANNEL, DISCARD_UNSAVED_CHANNEL, UNSAVED_CHANNEL, type AppEvent } from '@shared/contract';

/** Windows whose page reports unsaved edits. */
const unsaved = new WeakSet<WebContents>();
/** What repeats a window's held close or reload once the owner discards. */
const held = new WeakMap<WebContents, () => void>();
/** Windows with a close past every hold: a refused unload there was that close, not a reload. */
const closing = new WeakSet<WebContents>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  ipcMain.on(UNSAVED_CHANNEL, (e, on: unknown) => void (on === true ? unsaved.add(e.sender) : unsaved.delete(e.sender)));
  ipcMain.on(DISCARD_UNSAVED_CHANNEL, (e) => {
    unsaved.delete(e.sender);
    const repeat = held.get(e.sender);
    held.delete(e.sender);
    repeat?.();
  });
}

function ask(wc: WebContents, repeat: () => void): void {
  held.set(wc, repeat);
  const event: AppEvent = { type: 'unsaved-changes' };
  wc.send(APP_EVENT_CHANNEL, event);
}

/** For a caller closing `win` on purpose (a restart): asks first when it holds unsaved edits, and Discard runs `repeat`. */
export function askIfUnsaved(win: BrowserWindow, repeat: () => void): boolean {
  if (!unsaved.has(win.webContents)) return false;
  ask(win.webContents, repeat);
  return true;
}

/**
 * Called from a window's 'close' handler, after any hold that keeps the page alive (hiding to the tray) and before
 * any that tears part of it down (the Discord view's unload). True when held for the owner's answer.
 */
export function holdCloseIfUnsaved(win: BrowserWindow, e: Electron.Event): boolean {
  if (askIfUnsaved(win, () => win.close())) {
    e.preventDefault();
    return true;
  }
  closing.add(win.webContents);
  return false;
}

/**
 * Asks when the page's beforeunload refuses an unload main didn't hold: a reload, or a close requested before the
 * page's report arrived. Residual: a restart in that window repeats as a plain close, so the app quits without relaunching.
 */
export function guardUnsavedChanges(win: BrowserWindow): void {
  listen();
  const wc = win.webContents;
  wc.on('will-prevent-unload', () => {
    // Left un-prevented, the unload is cancelled; Discard repeats it.
    const wasClosing = closing.delete(wc);
    ask(wc, wasClosing ? () => win.close() : () => wc.reload());
  });
}
