// Restarting the app through its graceful close, packaged or under `pnpm dev`.
import { spawn } from 'node:child_process';
import { app, type BrowserWindow } from 'electron';
import { askIfUnsaved } from './unsavedChanges';

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

/** Dev relaunch reruns the package script with Electron arguments because its server stops with Electron. Returns null outside package-script launches. */
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

/** Arms atQuit only for completed graceful window closure. Canceled closes run nothing; repeated requests close again. Preserves Discord login without direct app.quit/exit. */
export function closeThen(win: BrowserWindow, atQuit: () => void): void {
  // Asked before arming: a kept edit leaves nothing armed, and Discard comes back here.
  if (askIfUnsaved(win, () => closeThen(win, atQuit))) return;
  if (!armed) {
    const step = atQuit;
    armed = step;
    app.once('will-quit', step);
    // The page refused to unload (edits main hadn't heard of yet): the close is cancelled (main/unsavedChanges).
    win.webContents.once('will-prevent-unload', () => {
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
