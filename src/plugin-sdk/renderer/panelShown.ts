import { createComputed, createSignal, type Accessor } from 'solid-js';
import { onCleanup } from './containment';

const [panels, setPanels] = createSignal<ReadonlyMap<string, ReadonlyMap<symbol, boolean>>>(new Map());
const [visible, setVisible] = createSignal(typeof document === 'undefined' || document.visibilityState !== 'hidden');
if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => setVisible(document.visibilityState !== 'hidden'));

/** Host slots and phone sections register their actual visibility; multiple placements may show the same panel. */
export function trackPanelShown(panelId: Accessor<string>, shown: Accessor<boolean>): void {
  const placement = Symbol();
  let previous: string | undefined;
  const update = (id: string, value?: boolean): void => void setPanels((before) => {
    const next = new Map(before), places = new Map(next.get(id));
    if (value === undefined) places.delete(placement); else places.set(placement, value);
    if (places.size) next.set(id, places); else next.delete(id);
    return next;
  });
  createComputed(() => {
    const id = panelId(), value = shown();
    if (previous && previous !== id) update(previous);
    previous = id;
    update(id, value);
  });
  onCleanup(() => { if (previous) update(previous); });
}

/** A mounted, expanded desktop placement or selected phone section, while its page is visible. */
export const panelShown = (panelId: string): Accessor<boolean> => () => visible() && [...(panels().get(panelId)?.values() ?? [])].some(Boolean);

/** Page visibility for mounted non-panel views and badge readers. */
export const pageShown: Accessor<boolean> = visible;
