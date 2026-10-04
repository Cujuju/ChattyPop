import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { isPanelCollapsed } from '@/state/layout';
import { markPanelSeen, panelShown } from '@/state/unread';
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

/** Marks panel `id` seen while `el` is on screen (createShown). Call from a component body; stops with its owner. */
export function markSeenWhileShown(el: Element, id: () => string): void {
  const shown = createShown(el, id);
  createEffect(on(shown, (now) => now && panelShown(id())));
  // Re-runs as new items arrive, so what appears while the panel is shown never counts as unseen.
  createEffect(() => {
    if (shown()) markPanelSeen(id());
  });
}
