// Restarting the app through its graceful close, packaged or under `pnpm dev`.
import { app, type BrowserWindow } from 'electron';
import { RESTART_ARMED_MESSAGE, RESTART_CANCELLED_MESSAGE } from '@shared/splash.mjs';
import { askIfUnsaved } from './unsavedChanges';

/** What a restart runs around the window's close: `armed` once under way, `cancelled` if the page refuses it, `atQuit` while quitting. */
interface RestartSteps {
  armed(): void;
  cancelled(): void;
  atQuit(): void;
}

const nothing = (): void => undefined;

/**
 * A launcher that spawned this process with an IPC channel (scripts/dev.mjs) starts it again itself: a process started
 * from here dies with that launcher's pnpm, which ends its job's processes as it exits. It is told before quitting. Else Electron's relaunch.
 */
function relaunchSteps(): RestartSteps {
  const send = process.send?.bind(process);
  if (!send) return { armed: nothing, cancelled: nothing, atQuit: () => app.relaunch() };
  return { armed: () => send(RESTART_ARMED_MESSAGE), cancelled: () => send(RESTART_CANCELLED_MESSAGE), atQuit: nothing };
}

/** The restart a close under way runs; a second request only closes again, so one runs. */
let armed: RestartSteps | null = null;

/** Arms the restart only for a completed graceful window closure; a cancelled close runs `cancelled`. Preserves Discord login without direct app.quit/exit. */
function closeThen(win: BrowserWindow, steps: RestartSteps): void {
  // Asked before arming: a kept edit leaves nothing armed, and Discard comes back here.
  if (askIfUnsaved(win, () => closeThen(win, steps))) return;
  if (!armed) {
    armed = steps;
    const atQuit = (): void => steps.atQuit();
    app.once('will-quit', atQuit);
    steps.armed();
    // The page refused to unload (edits main hadn't heard of yet): the close is cancelled (main/unsavedChanges).
    win.webContents.once('will-prevent-unload', () => {
      app.off('will-quit', atQuit);
      armed = null;
      steps.cancelled();
    });
  }
  win.close();
}

/** What a restart runs: a downloaded update's installer, which starts ChattyPop again itself, else a relaunch. */
let restartSteps: () => RestartSteps = relaunchSteps;

/** Makes every restart install the downloaded update (main/updates.ts), so no relaunch races its installer. */
export function installOnRestart(install: () => void): void {
  restartSteps = () => ({ armed: nothing, cancelled: nothing, atQuit: install });
}

/** Restarts ChattyPop through its graceful close, installing a downloaded update on the way. */
export const restartApp = (win: BrowserWindow): void => closeThen(win, restartSteps());
