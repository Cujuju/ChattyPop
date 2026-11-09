import { trackPanelShown } from '@plugin-sdk/renderer/panelShown';
import { isPanelCollapsed } from '@/state/layout';
import { onMount, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { lookupPanel } from '@/panels/registry';
import { panelIdentity, panelImportance } from '@/panels/titles';
import { markSeenWhileShown } from '@/ui/seen';
import { createViewShown } from '@/ui/contained';
import { PanelHeader } from '@/ui/PanelHeader';
import type { LayoutPanelId } from './types';
import styles from './Layout.module.css';

/** One-cell grid: a panel's root always stretches to fill its slot (or window) in both directions. */
export const ONE_CELL_GRID: JSX.CSSProperties = { display: 'grid', 'grid-template': 'minmax(0, 1fr) / minmax(0, 1fr)' };

/** A panel filling its tile (or the status bar frame). `hidden`: another tab of its group is showing. */
export function PanelSlot(props: { id: LayoutPanelId; hidden: boolean }) {
  const view = createViewShown();
  trackPanelShown(() => props.id, () => !props.hidden && !isPanelCollapsed(props.id) && view.shows());
  const def = () => lookupPanel(props.id);
  let slot!: HTMLDivElement;
  onMount(() => markSeenWhileShown(slot, () => props.id, view));
  return (
    <div
      ref={slot}
      class={styles.slot}
      data-panel={props.id}
      {...panelIdentity(props.id)}
      data-importance={panelImportance(props.id)}
      style={{ ...ONE_CELL_GRID, overflow: 'hidden' }}
    >
      <view.Watch><Dynamic component={def()?.component ?? (() => <MissingPanel id={props.id} />)} /></view.Watch>
    </div>
  );
}

/** Rendered for ids no longer registered (e.g. a removed plugin), so a saved layout never breaks; its header still moves and removes it. */
function MissingPanel(props: { id: string }) {
  return (
    <section class={styles.missingPanel}>
      <PanelHeader section="plugin" panelId={props.id} title={props.id} />
      <div class={styles.missing}>Panel “{props.id}” is not available.</div>
    </section>
  );
}
