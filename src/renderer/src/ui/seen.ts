import { createEffect, createMemo, createReaction, on, untrack, type Accessor } from 'solid-js';
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { isPanelCollapsed } from '@/state/layout';
import { markPanelSeen, panelShown } from '@/state/unread';
import { createOnScreen, pageVisible, windowFocused } from './looking';
import type { ViewShown } from './contained';

/** Component-owned visibility requires viewport presence, non-minimized window and unfolded panel. */
export function createShown(el: Element, id: () => string): Accessor<boolean> {
  const inView = createOnScreen(el);
  return createMemo(() => inView() && pageVisible() && !isPanelCollapsed(id()));
}

/** Desktop read eligibility requires window focus, excluding tray/background windows. Phone always returns true. */
export const createWindowFocused = (): Accessor<boolean> => windowFocused;

/** Marks panel `id` seen while `el` is on screen (createShown). Call from a component body; stops with its owner. */
export function markSeenWhileShown(el: Element, id: () => string, view?: ViewShown): void {
  const shown = createShown(el, id);
  const eligible = createMemo(() => shown() && (view?.shows() ?? true));
  let disposed = false;
  onCleanup(() => { disposed = true; });
  // Boundary handlers finish their effect queues before seen marks run.
  const afterUpdate = queueMicrotask;
  const mark = (): void => { if (!disposed && eligible()) track(() => markPanelSeen(id())); };
  const track = createReaction(() => afterUpdate(mark));
  createEffect(() => {
    id();
    if (eligible()) afterUpdate(mark);
  });
  createEffect(on(eligible, (now, was) => {
    if (now && !was) afterUpdate(() => { if (!disposed && eligible()) untrack(() => panelShown(id())); });
  }));
}
