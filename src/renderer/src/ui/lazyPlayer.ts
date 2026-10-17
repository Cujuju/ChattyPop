// Looping media loaded the first time the owner can look at it (Lottie stickers). Playback follows the current state,
// not the state when its load started, so a load finishing after a hide leaves it paused.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createEffect, createSignal, type Accessor } from 'solid-js';

/** What a loaded animation offers. */
export interface Player {
  play(): void;
  pause(): void;
  destroy(): void;
}

/**
 * Loads once `looking()` first holds, then plays while `looking() && wanted()` and pauses otherwise. `load` gives null
 * when there's nothing to play (it failed). Owner-scoped: disposal destroys the player, and one loaded after is destroyed.
 */
export function createLazyPlayer<P extends Player>(looking: Accessor<boolean>, wanted: Accessor<boolean>, load: () => Promise<P | null>): Accessor<P | undefined> {
  const [player, setPlayer] = createSignal<P>();
  let started = false;
  let disposed = false;
  createEffect(() => {
    if (started || !looking()) return;
    started = true;
    void load().then((p) => {
      if (disposed) p?.destroy();
      else if (p) setPlayer(() => p);
    });
  });
  createEffect(() => {
    const p = player();
    if (!p) return;
    if (looking() && wanted()) p.play();
    else p.pause();
  });
  onCleanup(() => {
    disposed = true;
    player()?.destroy();
  });
  return player;
}
