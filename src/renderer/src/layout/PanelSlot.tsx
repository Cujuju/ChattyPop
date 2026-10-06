import { Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { lookupPanel } from '@/panels/registry';
import { panelIdentity, panelImportance } from '@/panels/titles';
import { moveLayoutPanel, revealRequest, swapLayoutPanels } from '@/state/layout';
import { draggedPanel, setDraggedPanel } from '@/state/ui';
import { markSeenWhileShown } from '@/ui/seen';
import { dropZones } from './panelMenu';
import { dropZoneAt, type DropZone } from './tree';
import type { LayoutPanelId, PanelRef, SplitSize } from './types';
import styles from './Layout.module.css';

// Structural styles only (flex geometry from layout data); visual styling lives in Layout.module.css.
export const sizeStyle = (size: SplitSize | undefined, hidden = false): JSX.CSSProperties =>
  hidden ? { display: 'none' } : size === 'auto' || size === undefined ? { flex: '0 0 auto' } : { flex: `${size} 1 0`, 'min-width': 0, 'min-height': 0 };

/** One-cell grid: a panel's root always stretches to fill its slot (or window) in both directions. */
export const ONE_CELL_GRID: JSX.CSSProperties = { display: 'grid', 'grid-template': 'minmax(0, 1fr) / minmax(0, 1fr)' };

/** data-fit-body panels enforce unscrolled content-height minimums in columns. Other panels/splits return zero; row shares have no such floor. */
export const fitHeight = (el: Element | null): number => {
  const body = el?.matches('[data-panel]') ? el.querySelector('[data-fit-body]') : null;
  return body ? body.getBoundingClientRect().top - el!.getBoundingClientRect().top + body.scrollHeight : 0;
};

export function PanelSlot(props: { panel: PanelRef; size: SplitSize | undefined; axis?: 'row' | 'column'; hidden: boolean }) {
  const def = () => lookupPanel(props.panel.id);
  let slot!: HTMLDivElement;
  const [fitPx, setFitPx] = createSignal(0);
  onMount(() => {
    markSeenWhileShown(slot, () => props.panel.id);
    // Re-measured on width changes (text rewraps) and content changes, which a clipped body doesn't resize for.
    const measure = (): void => void setFitPx(fitHeight(slot));
    const resize = new ResizeObserver(measure);
    const content = new MutationObserver(measure);
    resize.observe(slot);
    content.observe(slot, { childList: true, subtree: true, characterData: true });
    onCleanup(() => {
      resize.disconnect();
      content.disconnect();
    });
  });
  /** A share-sized slot in a column keeps its content height; the other shares give way. */
  const fitFloor = (): JSX.CSSProperties =>
    props.axis === 'column' && typeof props.size === 'number' && fitPx() > 0 ? { 'min-height': `${fitPx()}px` } : {};
  createEffect(on(revealRequest, (r) => r?.id === props.panel.id && slot.scrollIntoView({ block: 'nearest' }), { defer: true }));
  const zones = (): readonly DropZone[] => {
    const moved = draggedPanel();
    return moved && moved !== props.panel.id ? dropZones(props.panel.id, moved) : [];
  };
  return (
    <div
      ref={slot}
      class={styles.slot}
      data-panel={props.panel.id}
      {...panelIdentity(props.panel.id)}
      data-importance={panelImportance(props.panel.id)}
      hidden={props.hidden}
      style={{ ...ONE_CELL_GRID, overflow: 'hidden', ...sizeStyle(props.size, props.hidden), ...fitFloor() }}
    >
      <Dynamic component={def()?.component ?? (() => <MissingPanel id={props.panel.id} />)} />
      <Show when={zones().length > 0}>
        <DropZones target={props.panel.id} zones={zones()} />
      </Show>
    </div>
  );
}

/** Panel edge drops dock; center drops swap. Toolbar panels outside the layout replace center targets. */
function DropZones(props: { target: LayoutPanelId; zones: readonly DropZone[] }) {
  const [zone, setZone] = createSignal<DropZone | null>(null);
  const zoneAt = (e: DragEvent): DropZone | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return dropZoneAt(props.zones, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault(); // allows the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setZone(zoneAt(e));
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const moved = draggedPanel();
    const at = zoneAt(e);
    setDraggedPanel(null);
    if (!moved || !at) return;
    if (at === 'center') swapLayoutPanels(moved, props.target);
    else moveLayoutPanel(moved, props.target, at);
  };
  return (
    <div class={styles.dropZones} onDragOver={onDragOver} onDragLeave={() => setZone(null)} onDrop={onDrop}>
      <Show when={zone()}>{(z) => <div class={styles.dropPreview} data-zone={z()} />}</Show>
    </div>
  );
}

/** Rendered for ids no longer registered (e.g. a removed plugin), so a saved layout never breaks. */
function MissingPanel(props: { id: string }) {
  return <div class={styles.missing}>Panel “{props.id}” is not available.</div>;
}
