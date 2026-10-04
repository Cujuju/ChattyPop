// Restarting the app through its graceful close, packaged or under `pnpm dev`.
import { spawn } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';

/** How often the relauncher checks whether the dev session has exited. */
const POLL_MS = 250;
/** A graceful close takes seconds (the Discord page unloads first); past this the close was refused, so no relaunch. */
const GIVE_UP_MS = 60_000;
/** Where the relauncher reads its job. */
const JOB_ENV = 'CHATTYPOP_RELAUNCH';

interface RelaunchJob {
  /** The dev session's process (electron-vite), which exits after Electron and frees the dev server's port. */
  waitFor: number;
  giveUpAt: number;
  pollMs: number;
  cwd: string;
  command: string;
}

/** Runs in Electron as Node, detached: once `waitFor` exits, starts the dev command again. */
const RELAUNCHER = `
const { spawn } = require('node:child_process');
const job = JSON.parse(process.env.${JOB_ENV});
const alive = () => { try { process.kill(job.waitFor, 0); return true; } catch { return false; } };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.${JOB_ENV};
(function tick() {
  if (alive()) { if (Date.now() < job.giveUpAt) setTimeout(tick, job.pollMs); return; }
  spawn(job.command, { cwd: job.cwd, env, shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
})();
`;

/**
 * Under `pnpm dev` the dev server stops with Electron, so app.relaunch() would start a window with nothing to load:
 * the pnpm script runs again instead, with Electron's own arguments. Null when not started by a package script.
 */
function devRelaunchJob(): RelaunchJob | null {
  const script = process.env['npm_lifecycle_event'];
  if (app.isPackaged || !script) return null;
  const electronArgs = process.argv.slice(2).map((a) => JSON.stringify(a));
  return {
    waitFor: process.ppid,
    giveUpAt: Date.now() + GIVE_UP_MS,
    pollMs: POLL_MS,
    cwd: app.getAppPath(),
    command: ['pnpm', 'run', script, '--', ...electronArgs].join(' '),
  };
}

/** Starts ChattyPop again once this process exits: the dev script under `pnpm dev`, else Electron's relaunch. */
function relaunchAfterExit(): void {
  const job = devRelaunchJob();
  if (!job) {
    app.relaunch();
    return;
  }
  spawn(process.execPath, ['-e', RELAUNCHER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', [JOB_ENV]: JSON.stringify(job) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/** The quit step armed by a close under way; a second request only closes again, so one step follows. */
let armed: (() => void) | null = null;

/**
 * Quits ChattyPop through the graceful window close, then runs `atQuit`: never app.quit() or app.exit(), since only that
 * close keeps the Discord login. `atQuit` is armed for the quit the close leads to, so a close the owner cancels (unsaved
 * changes kept) runs nothing. While one is armed, another request only closes again.
 */
export function closeThen(win: BrowserWindow, atQuit: () => void): void {
  if (!armed) {
    const step = atQuit;
    armed = step;
    app.once('will-quit', step);
    // Runs after mainWindow's unsaved-changes dialog, which prevents the default only when the owner discards.
    win.webContents.once('will-prevent-unload', (e) => {
      if (e.defaultPrevented) return;
      app.off('will-quit', step);
      armed = null;
    });
  }
  win.close();
}

/** What a restart runs once quitting: a downloaded update's installer, which starts ChattyPop again itself, else a relaunch. */
let restartStep: () => void = relaunchAfterExit;

/** Makes every restart install the downloaded update (main/updates.ts), so no relaunch races its installer. */
export function installOnRestart(install: () => void): void {
  restartStep = install;
}

/** Restarts ChattyPop through its graceful close, installing a downloaded update on the way. */
export const restartApp = (win: BrowserWindow): void => closeThen(win, () => restartStep());
