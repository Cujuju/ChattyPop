import { Show, onMount } from 'solid-js';
import { windowControls } from '@/api';
import { WindowBar } from './WindowBar';
import { Dynamic } from 'solid-js/web';
import { titleOf } from '@/layout/panelMenu';
import { ONE_CELL_GRID } from '@/layout/PanelSlot';
import styles from './PanelWindow.module.css';
import { lookupPanel } from '@/panels/registry';
import { panelIdentity, panelImportance } from '@/panels/titles';
import { markSeenWhileShown } from '@/ui/seen';
import { Overlays } from './Overlays';
import { PluginWindows } from '@/views/pluginWindows/PluginWindows';
import { Contained, createViewShown } from '@/ui/contained';

/** A panel in its own window: just the panel, filling the window, with the overlays and plugin windows its panel opens. */
export function PanelWindow(props: { id: string }) {
  const view = createViewShown();
  const def = () => lookupPanel(props.id);
  document.title = `${titleOf(props.id)} · ChattyPop`;
  let frame!: HTMLDivElement;
  onMount(() => markSeenWhileShown(frame, () => props.id, view));
  const controls = windowControls();
  return (
    // Structural frame only: the window's own title bar when frameless, over one cell the panel's root stretches to fill.
    // data-section/-importance: the same theme scope the panel gets in a layout slot.
    <div style={{ display: 'flex', 'flex-direction': 'column', width: '100%', height: '100%' }}>
      <Show when={controls}>{(c) => <WindowBar controls={c()} title={document.title} />}</Show>
      <div ref={frame} class={styles.frame} {...panelIdentity(props.id)} data-importance={panelImportance(props.id)} style={{ ...ONE_CELL_GRID, flex: '1 1 0', 'min-height': 0 }}>
        <view.Watch><Dynamic component={def()?.component ?? (() => <p>Panel unavailable: {props.id}</p>)} /></view.Watch>
        <Contained name="Plugin windows" shows="block"><PluginWindows /></Contained>
        <Contained name="Menus and viewers" shows="line"><Overlays /></Contained>
      </div>
    </div>
  );
}
