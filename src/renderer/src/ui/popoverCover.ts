// Every open popover reports the area it covers (state/windows overlay covers), so the native Discord view, which draws
// above all renderer UI, hides where a popover overlaps it. Automatic, so none needs wiring of its own: native top-layer
// popovers from any package (the colour picker, number picker pop-outs) and the app's own floating surfaces (.cp-popover:
// menus, selects, pickers). A hidden one measures empty and covers nothing.
import { coverOf, setOverlayCover } from '@/state/windows';

interface Tracked {
  id: string;
  stop: () => void;
}

const tracked = new Map<Element, Tracked>();
let nextId = 0;

function untrack(el: Element): void {
  const t = tracked.get(el);
  if (!t) return;
  t.stop();
  setOverlayCover(t.id, null);
  tracked.delete(el);
}

/** Reports `el`'s area now and whenever it moves (inline position) or resizes, until untracked. */
function track(el: HTMLElement): void {
  if (tracked.has(el)) return;
  const id = `popover-${nextId++}`;
  const report = (): void => setOverlayCover(id, coverOf(el));
  const resized = new ResizeObserver(report);
  resized.observe(el);
  // Packages position a popover through its inline style (top/left); a move changes no size.
  const moved = new MutationObserver(report);
  moved.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', report);
  window.addEventListener('scroll', report, { capture: true, passive: true });
  tracked.set(el, {
    id,
    stop: () => {
      resized.disconnect();
      moved.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, { capture: true });
    },
  });
  report();
}

/** The app's floating surfaces: the shared popover class (theme/shared-controls.css). */
const APP_POPOVER = '.cp-popover';

/** Tracks `node` and any app popovers inside it. */
function trackAppPopovers(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (node.matches(APP_POPOVER)) track(node);
  for (const el of node.querySelectorAll<HTMLElement>(APP_POPOVER)) track(el);
}

/**
 * Starts tracking popovers for this window. Native popovers: `toggle` doesn't bubble but is seen in capture; one removed
 * while open hides without a toggle event (the spec's removal steps fire none). App popovers: tracked while in the DOM.
 * So DOM additions and removals are watched.
 */
export function trackPopoverCovers(): void {
  document.addEventListener(
    'toggle',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.hasAttribute('popover')) return;
      if ((e as ToggleEvent).newState === 'open') track(el);
      else untrack(el);
    },
    { capture: true },
  );
  trackAppPopovers(document.body);
  new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) trackAppPopovers(node);
    for (const el of [...tracked.keys()]) if (!el.isConnected) untrack(el);
  }).observe(document.body, { childList: true, subtree: true });
}
