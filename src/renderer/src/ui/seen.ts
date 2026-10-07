import { createEffect, createMemo, on, type Accessor } from 'solid-js';
import { isPanelCollapsed } from '@/state/layout';
import { markPanelSeen, panelShown } from '@/state/unread';
import { createOnScreen, pageVisible, windowFocused } from './looking';

/** Component-owned visibility requires viewport presence, non-minimized window and unfolded panel. */
export function createShown(el: Element, id: () => string): Accessor<boolean> {
  const inView = createOnScreen(el);
  return createMemo(() => inView() && pageVisible() && !isPanelCollapsed(id()));
}

/** Desktop read eligibility requires window focus, excluding tray/background windows. Phone always returns true. */
export const createWindowFocused = (): Accessor<boolean> => windowFocused;

/** Marks panel `id` seen while `el` is on screen (createShown). Call from a component body; stops with its owner. */
export function markSeenWhileShown(el: Element, id: () => string): void {
  const shown = createShown(el, id);
  createEffect(on(shown, (now) => now && panelShown(id())));
  // Re-runs as new items arrive, so what appears while the panel is shown never counts as unseen.
  createEffect(() => {
    if (shown()) markPanelSeen(id());
  });
}
