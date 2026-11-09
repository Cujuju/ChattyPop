import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createEffect, createSignal, onMount } from 'solid-js';
import { TilingWorkspace, type TileContext } from '@cujuju/solidjs-tiling-window-manager';
import { cancelPlacing, placePanel, popOutPanel, setShownTiles, shownTiles } from '@/state/layout';
import { draggedPanel, placingPanel, setDraggedPanel } from '@/state/ui';
import { detachable, titleOf } from './panelMenu';
import { PanelSlot } from './PanelSlot';
import { TileScope } from './tileContext';
import { watchWorkspaceActivity } from './workspaceActivity';
import styles from './Layout.module.css';

/** Narrowest and shortest a panel may be dragged: room for its header and a line of content. */
const MIN_PANEL_PX = 120;
const MIN_PANEL = { width: MIN_PANEL_PX, height: MIN_PANEL_PX };
/** The status bar is the app frame, below the workspace, never a tile. */
const STATUS_BAR = 'status-bar';

/** Theme lengths the workspace lays out with, read from probes sized by --cp-* tokens (Layout.module.css). */
function createThemeLengths() {
  const [gap, setGap] = createSignal(0);
  const [bar, setBar] = createSignal(0);
  const [strip, setStrip] = createSignal(0);
  let gapProbe!: HTMLDivElement;
  let barProbe!: HTMLDivElement;
  let stripProbe!: HTMLDivElement;
  onMount(() => {
    const measure = (): void => {
      setGap(gapProbe.offsetWidth);
      setBar(barProbe.offsetHeight);
      setStrip(stripProbe.offsetWidth);
    };
    const observer = new ResizeObserver(measure);
    for (const probe of [gapProbe, barProbe, stripProbe]) observer.observe(probe);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const probes = (
    <div class={styles.probes} aria-hidden="true">
      <div ref={gapProbe} class={styles.gapProbe} />
      <div ref={barProbe} class={styles.barProbe} />
      <div ref={stripProbe} class={styles.stripProbe} />
    </div>
  );
  return { gap, bar, strip, probes };
}

/** Dock drags hide the native Discord view (state/overlay): mirrors tile `tile`'s drag into draggedPanel. */
function reportDrag(tile: TileContext): void {
  createEffect(() => {
    if (tile.dragging()) setDraggedPanel(tile.id);
    else if (draggedPanel() === tile.id) setDraggedPanel(null);
  });
  onCleanup(() => draggedPanel() === tile.id && setDraggedPanel(null));
}

/** The main window's tiling workspace over the layout store, with the status bar as a fixed frame below it. */
export function LayoutRoot() {
  const lengths = createThemeLengths();
  let host!: HTMLDivElement;
  onMount(() => {
    const workspace = host.querySelector<HTMLElement>(':scope > .twm');
    if (workspace) watchWorkspaceActivity(workspace);
  });
  const placing = () => {
    const id = placingPanel();
    return id ? { id, label: titleOf(id) } : null;
  };
  return (
    <div class={styles.root}>
      {lengths.probes}
      <div ref={host} class={styles.host}>
        <TilingWorkspace
          class={styles.workspace}
          layout={shownTiles()}
          onLayoutChange={(next) => setShownTiles(next)}
          minSize={() => MIN_PANEL}
          gapPx={lengths.gap()}
          tabs
          collapse={{ barPx: lengths.bar(), stripPx: lengths.strip() }}
          readout
          keyboardPlacement={{ label: titleOf }}
          placement="reflow"
          placing={placing()}
          onPlace={(id, next) => placePanel(id, next)}
          onPlacingCancel={cancelPlacing}
          onDropOutside={(id) => detachable(id) && popOutPanel(id)}
          empty={<p class={styles.empty}>No panels in the layout. Add one from the Layout button in the top bar.</p>}
        >
          {(tile) => {
            reportDrag(tile);
            // The tile in scope makes the panel's header its grip, tab strip and tab target.
            return (
              <TileScope.Provider value={tile}>
                <PanelSlot id={tile.id} hidden={!tile.visible()} />
              </TileScope.Provider>
            );
          }}
        </TilingWorkspace>
      </div>
      <div class={styles.frameBar}>
        <PanelSlot id={STATUS_BAR} hidden={false} />
      </div>
    </div>
  );
}
