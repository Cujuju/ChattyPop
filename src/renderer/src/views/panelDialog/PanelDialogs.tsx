import { For, Show, createEffect, onMount } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { ONE_CELL_GRID } from '@/layout/PanelSlot';
import { titleOf } from '@/layout/panelMenu';
import { lookupPanel } from '@/panels/registry';
import { panelIdentity, panelImportance } from '@/panels/titles';
import { isPlaced } from '@/state/layout';
import { DIALOG_PANELS, closePanelDialog, panelDialogWindowId, panelDialogs } from '@/state/ui';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { markSeenWhileShown } from '@/ui/seen';
import chrome from '@/ui/WindowChrome.module.css';

/** The panel filling the window below its title bar; mounted only while open, so it loads nothing when closed. */
function PanelBody(props: { id: string }) {
  let frame!: HTMLDivElement;
  onMount(() => markSeenWhileShown(frame, () => props.id));
  return (
    // Structural frame only, as in PanelWindow: one cell the panel's root stretches to fill.
    <div ref={frame} {...panelIdentity(props.id)} data-importance={panelImportance(props.id)} style={{ ...ONE_CELL_GRID, flex: '1 1 0', 'min-height': 0 }}>
      <Dynamic component={lookupPanel(props.id)?.component} />
    </div>
  );
}

function PanelDialog(props: { id: string }) {
  const title = titleOf(props.id);
  const titleId = `panel-dialog-${props.id}-title`;
  const open = (): boolean => panelDialogs().includes(props.id);
  const close = (): void => closePanelDialog(props.id);
  // One place per panel: dragging it into the layout closes its window.
  createEffect(() => {
    if (open() && (isPlaced(props.id) || !lookupPanel(props.id))) close();
  });
  return (
    <FloatingWindow id={panelDialogWindowId(props.id)} open={open()} class={chrome.dialog} aria-labelledby={titleId} onClose={close}>
      <WindowHeader title={title} titleId={titleId} classes={chrome} closeLabel={`Close ${title}`} onClose={close} />
      <Show when={open()}>
        <PanelBody id={props.id} />
      </Show>
    </FloatingWindow>
  );
}

/** Panels the top bar opens in the main window as floating windows (DIALOG_PANELS), like Settings. */
export function PanelDialogs() {
  return <For each={DIALOG_PANELS}>{(id) => <PanelDialog id={id} />}</For>;
}
