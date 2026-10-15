import { CONTAINMENT_ADAPTER } from './containmentBuild';

export const SEEN_STATE = `
import { createSignal } from 'solid-js';
export const [items, setItems] = createSignal(0);
export const [visible, setVisible] = createSignal(true);
export const [loading, setLoading] = createSignal(true);
export const [seeded, setSeeded] = createSignal(null);
export const [panelId, setPanelId] = createSignal('probe');
export const marked = [], shown = [], shownWatermarks = [];
export const createOnScreen = () => visible;
export const pageVisible = () => true, windowFocused = () => true;
export const isPanelCollapsed = () => false;
export const markPanelSeen = id => {
  if (id === 'watermark') { marked.push(items()); setSeeded(items()); return; }
  if (panelId() === 'plans') {
    if (loading()) return;
    if (seeded() === null) { marked.push(items()); setSeeded(items()); }
  } else marked.push(items());
};
export const panelShown = id => {
  shown.push(id);
  if (id === 'watermark') shownWatermarks.push(seeded());
  if (id === 'throwing') throw new Error('Shown failure');
};
`;

export const SEEN_VIEWS_SOURCE = `
import { createEffect, createMemo, createRenderEffect, createSignal, onMount } from 'solid-js';
import { Contained, createViewShown } from '@/ui/contained';
import { markSeenWhileShown } from '@/ui/seen';
import { node, render } from '${CONTAINMENT_ADAPTER}';
import { items, setItems, setVisible, setLoading, seeded, setSeeded, panelId, setPanelId, marked, shown, shownWatermarks } from 'test:seen-state';

export function mountSeen(kind, nested = false, watched = true) {
  setItems(0); setVisible(true); marked.length = 0; shown.length = 0; shownWatermarks.length = 0;
  setLoading(true); setSeeded(null); setPanelId(['plans', 'watermark', 'throwing'].includes(kind) ? kind : 'probe');
  const [healthy, setHealthy] = createSignal(false);
  const root = node('root');
  let view;
  const Body = () => {
    if (kind === 'throwing') onMount(() => markSeenWhileShown(root, panelId));
    const check = () => { if (items() > 0 && !healthy()) throw new Error('View failure'); };
    if (kind === 'memo') createMemo(check);
    else if (kind === 'render') createRenderEffect(check);
    else createEffect(check);
    return <span>Ready {items()}</span>;
  };
  const dispose = render(() => {
    view = createViewShown();
    if (kind !== 'throwing') onMount(() => markSeenWhileShown(root, panelId, watched ? view : undefined));
    return <view.Watch><Contained name="Panel" shows="line">
      {nested ? <Contained name="Inner" shows="line"><Body /></Contained> : <Body />}
    </Contained></view.Watch>;
  }, root);
  return { root, dispose, set: setItems, visible: setVisible, loading: setLoading, seeded, id: setPanelId, healthy: () => setHealthy(true), marked, shown, shownWatermarks, shows: view.shows };
}
`;
