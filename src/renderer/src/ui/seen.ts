import { createEffect, createMemo, createReaction, getOwner, on, runWithOwner, untrack, type Accessor } from 'solid-js';
import { trackPanelShown } from '@plugin-sdk/renderer/panelShown';
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
  const owner = getOwner();
  const shown = createShown(el, id);
  const eligible = createMemo(() => shown() && (view?.shows() ?? true));
  trackPanelShown(id, eligible);
  let disposed = false;
  let pendingShown = false;
  onCleanup(() => { disposed = true; });
  // Boundary handlers finish their effect queues before seen marks run.
  const afterUpdate = queueMicrotask;
  const mark = (): void => {
    if (disposed || !eligible()) return;
    if (pendingShown) {
      pendingShown = false;
      runWithOwner(owner, () => untrack(() => panelShown(id())));
    }
    if (!disposed && eligible()) track(() => markPanelSeen(id()));
  };
  const track = createReaction(() => afterUpdate(mark));
  createEffect(() => {
    id();
    if (eligible()) afterUpdate(mark);
  });
  createEffect(on(eligible, (now, was) => {
    pendingShown = Boolean(now && !was);
  }));
}
