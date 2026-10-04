import { onMount } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { titleOf } from '@/layout/panelMenu';
import { ONE_CELL_GRID } from '@/layout/PanelSlot';
import styles from './PanelWindow.module.css';
import { lookupPanel } from '@/panels/registry';
import { panelIdentity, panelImportance } from '@/panels/titles';
import { markSeenWhileShown } from '@/ui/seen';
import { Overlays } from './Overlays';

/** A panel in its own window: just the panel, filling the window, with the overlays panels open (menus, image viewer, Jev). */
export function PanelWindow(props: { id: string }) {
  const def = () => lookupPanel(props.id);
  document.title = `${titleOf(props.id)} · ChattyPop`;
  let frame!: HTMLDivElement;
  onMount(() => markSeenWhileShown(frame, () => props.id));
  return (
    // Structural frame only: one cell the panel's root stretches to fill.
    // data-section/-importance: the same theme scope the panel gets in a layout slot.
    <div ref={frame} class={styles.frame} {...panelIdentity(props.id)} data-importance={panelImportance(props.id)} style={{ ...ONE_CELL_GRID, width: '100%', height: '100%' }}>
      <Dynamic component={def()?.component ?? (() => <p>Panel unavailable: {props.id}</p>)} />
      <Overlays />
    </div>
  );
}
