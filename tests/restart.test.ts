// A restart under a launcher with an IPC channel (scripts/dev.mjs) tells the launcher, which starts the app again;
// nothing this process starts survives the launcher's pnpm (#124). Without one, Electron relaunches.
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_ARMED_MESSAGE, RESTART_CANCELLED_MESSAGE } from '@shared/splash.mjs';

const app = Object.assign(new EventEmitter(), { relaunch: vi.fn() });
vi.mock('electron', () => ({ app }));
vi.mock('../src/main/unsavedChanges', () => ({ askIfUnsaved: () => false }));

const realSend = process.send;
let sent: unknown[];
let win: BrowserWindow & { webContents: EventEmitter };

/** Stands in for the launcher's IPC channel. */
const toLauncher = ((m: unknown) => sent.push(m) > 0) as typeof process.send;

/** A fresh module: its armed restart is module state. */
const load = async () => {
  vi.resetModules();
  return import('../src/main/restart');
};

beforeEach(() => {
  sent = [];
  app.removeAllListeners();
  app.relaunch.mockClear();
  win = { close: vi.fn(), webContents: new EventEmitter() } as unknown as typeof win;
});

afterEach(() => {
  process.send = realSend;
});

describe('restartApp', () => {
  it('under a launcher, tells it before closing and starts nothing itself', async () => {
    process.send = toLauncher;
    const { restartApp } = await load();
    restartApp(win);
    expect(sent).toEqual([RESTART_ARMED_MESSAGE]);
    expect(win.close).toHaveBeenCalledOnce();
    app.emit('will-quit');
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it('under a launcher, withdraws the restart when the page refuses the close', async () => {
    process.send = toLauncher;
    const { restartApp } = await load();
    restartApp(win);
    win.webContents.emit('will-prevent-unload');
    expect(sent).toEqual([RESTART_ARMED_MESSAGE, RESTART_CANCELLED_MESSAGE]);
    app.emit('will-quit');
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it('without a launcher, relaunches only once quitting', async () => {
    process.send = undefined;
    const { restartApp } = await load();
    restartApp(win);
    expect(app.relaunch).not.toHaveBeenCalled();
    app.emit('will-quit');
    expect(app.relaunch).toHaveBeenCalledOnce();
  });

  it('with an update downloaded, runs its installer instead of relaunching', async () => {
    process.send = undefined;
    const { restartApp, installOnRestart } = await load();
    const install = vi.fn();
    installOnRestart(install);
    restartApp(win);
    app.emit('will-quit');
    expect(install).toHaveBeenCalledOnce();
    expect(app.relaunch).not.toHaveBeenCalled();
  });
});
