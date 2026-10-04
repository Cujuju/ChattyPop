import { onCleanup } from 'solid-js';

type Target = Window | Document | HTMLElement;
type EventMap<T extends Target> = T extends Window ? WindowEventMap : T extends Document ? DocumentEventMap : HTMLElementEventMap;

/** Adds a listener and removes it (with the same capture flag) when the current owner is disposed. Call inside an owner. */
export function listen<T extends Target, K extends keyof EventMap<T> & string>(
  target: T,
  type: K,
  fn: (e: EventMap<T>[K]) => void,
  opts?: boolean | AddEventListenerOptions,
): void {
  const handler = fn as unknown as EventListener;
  target.addEventListener(type, handler, opts);
  onCleanup(() => target.removeEventListener(type, handler, opts));
}

/**
 * Calls `close` on a mouse press outside `el` while `open()`. Capture phase, so a stopPropagation inside the page can't
 * keep the popup open.
 */
export function onPointerDownOutside(el: () => Element | undefined, open: () => boolean, close: () => void): void {
  listen(
    window,
    'mousedown',
    (e) => {
      const root = el();
      if (open() && root && !root.contains(e.target as Node)) close();
    },
    true,
  );
}
