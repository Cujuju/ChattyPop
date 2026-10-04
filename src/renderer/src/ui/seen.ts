import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { isPanelCollapsed } from '@/state/layout';
import { markPanelSeen, panelShown } from '@/state/unread';
import { inCompanion } from '@/state/ui';
import { listen } from './listen';

/**
 * True while `el` is on screen: inside the viewport (so not display:none, e.g. an inactive tab), its window not
 * minimized, and panel `id` not folded. Call from a component body; stops with its owner.
 */
export function createShown(el: Element, id: () => string): Accessor<boolean> {
  const [inView, setInView] = createSignal(false);
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState === 'visible');
  const io = new IntersectionObserver((entries) => setInView(entries.at(-1)?.isIntersecting ?? false));
  io.observe(el);
  listen(document, 'visibilitychange', () => void setPageVisible(document.visibilityState === 'visible'));
  onCleanup(() => io.disconnect());
  return createMemo(() => inView() && pageVisible() && !isPanelCollapsed(id()));
}

/**
 * True while this window has focus, as Discord's client requires before it marks a channel read: a window behind
 * another app's, or created hidden (the tray), isn't read. The phone has no other window: always true there.
 */
export function createWindowFocused(): Accessor<boolean> {
  if (inCompanion) return () => true;
  const [focused, setFocused] = createSignal(document.hasFocus());
  listen(window, 'focus', () => void setFocused(true));
  listen(window, 'blur', () => void setFocused(false));
  return focused;
}

/** Marks panel `id` seen while `el` is on screen (createShown). Call from a component body; stops with its owner. */
export function markSeenWhileShown(el: Element, id: () => string): void {
  const shown = createShown(el, id);
  createEffect(on(shown, (now) => now && panelShown(id())));
  // Re-runs as new items arrive, so what appears while the panel is shown never counts as unseen.
  createEffect(() => {
    if (shown()) markPanelSeen(id());
  });
}
