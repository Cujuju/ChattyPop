// Floating windows (Settings, Jev, Person, Conversation): non-modal, dragged by their header, resized from any edge.
// Each window's last geometry persists; open windows stack in the order they were last raised.
import { createSignal } from 'solid-js';
import type { WindowRect } from '@/ui/windowResize';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { recordOf } from '@shared/normalize';

export type { WindowRect };

const isRect = (v: unknown): v is WindowRect => {
  const r = v as Partial<WindowRect> | null;
  return !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n));
};

const [savedWindows, setSavedWindows] = createSetting<Record<string, WindowRect>>('layout.windows', {}, recordOf(isRect));
export { savedWindows };

export const saveWindow = (id: string, rect: WindowRect): void => void setSavedWindows({ ...savedWindows(), [id]: rect });

/** Open windows with their current rects, front-most last. */
const [openWindows, setOpenWindows] = createSignal<{ id: string; rect: WindowRect }[]>([]);

/** Stacking rank among open windows (0 = back); -1 when closed. */
export const windowRank = (id: string): number => openWindows().findIndex((w) => w.id === id);

/** Records an open window's rect; with `raise`, it moves to the front. */
export function trackWindow(id: string, rect: WindowRect, raise = false): void {
  const rest = openWindows().filter((w) => w.id !== id);
  const at = openWindows().findIndex((w) => w.id === id);
  if (raise || at === -1) setOpenWindows([...rest, { id, rect }]);
  else setOpenWindows(openWindows().map((w) => (w.id === id ? { id, rect } : w)));
}

/** Whether an open window other than `id` has its top-left corner at (x, y). */
export const windowAt = (id: string, x: number, y: number): boolean => openWindows().some((w) => w.id !== id && w.rect.x === x && w.rect.y === y);

/** Moves an open window to the front; nothing when closed. */
export function raiseWindow(id: string): void {
  const w = openWindows().find((o) => o.id === id);
  if (w) trackWindow(id, w.rect, true);
}

export const untrackWindow = (id: string): void => {
  setOpenWindows(openWindows().filter((w) => w.id !== id));
};

/** Open overlays that aren't floating windows (the image viewer, menus, pickers), by id: the area each covers. */
const [overlays, setOverlays] = createSignal<ReadonlyMap<string, WindowRect | 'window'>>(new Map());

/** Records the area an overlay covers while open (`'window'`: all of it); null when it closes. */
export function setOverlayCover(id: string, area: WindowRect | 'window' | null): void {
  // The updater form reads without subscribing, so an effect calling this doesn't re-run on its own write.
  setOverlays((prev) => {
    if (sameArea(prev.get(id), area ?? undefined)) return prev;
    const next = new Map(prev);
    if (area) next.set(id, area);
    else next.delete(id);
    return next;
  });
}

const sameArea = (a: WindowRect | 'window' | undefined, b: WindowRect | 'window' | undefined): boolean =>
  a === b || (typeof a === 'object' && typeof b === 'object' && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

const overlaps = (w: WindowRect, r: DOMRect): boolean => w.x < r.right && w.x + w.width > r.left && w.y < r.bottom && w.y + w.height > r.top;

/** Checks reported overlay/window coverage of native Discord bounds. Covered views hide; unreported overlays remain beneath the native view. */
export const windowsCover = (r: DOMRect): boolean =>
  openWindows().some(({ rect }) => overlaps(rect, r)) || [...overlays().values()].some((a) => a === 'window' || overlaps(a, r));

/** An overlay covers the whole window (the image viewer, a modal dialog). */
export const windowCovered = (): boolean => [...overlays().values()].includes('window');

/** An element's area as an overlay cover. */
export const coverOf = (el: Element): WindowRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
