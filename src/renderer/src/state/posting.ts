// Renderer posting state follows enabled unlocking plugins. Governs visible/startable UI; main independently enforces writes.
import { createEffect, createRoot } from 'solid-js';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { postingUnlockedIn } from '@shared/posting';
import { plugins, pluginsLoaded } from './plugins';

/**
 * Whether posting is unlocked, read from core's plugin list only: locked until it arrives (pluginActive's optimistic
 * guess never unlocks). Reactive: follows plugins turning on and off.
 */
export const postingUnlocked = (): boolean => pluginsLoaded() && postingUnlockedIn(BUNDLED_PLUGINS, plugins());

/** Calls `close` whenever `isOpen()` while posting is locked: a posting window or dialog never stays open locked. */
export function closeWhenLocked(isOpen: () => boolean, close: () => void): void {
  createRoot(() =>
    createEffect(() => {
      if (isOpen() && !postingUnlocked()) close();
    }),
  );
}
