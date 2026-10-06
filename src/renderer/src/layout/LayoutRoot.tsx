import { For, Match, Show, Switch, createEffect, createSignal, on, type JSX } from 'solid-js';
import { isPanelCollapsed, revealRequest, setSplitSizes, sidebarCollapsed, splitSizes, tabPicks, type SplitPath } from '@/state/layout';
import { setResizing } from '@/state/ui';
import { panelIdentity } from '@/panels/titles';
import { titleOf } from './panelMenu';
import { PanelSlot, fitHeight, sizeStyle } from './PanelSlot';
import { createTabSelection } from './tabSelection';
import { childPath, contentSized, effectiveSizes, nextShare, normalizeShares, panelIds, resizeShares } from './tree';
import type { LayoutNode, PanelRef, SplitSize } from './types';
import styles from './Layout.module.css';

export function LayoutRoot(props: { root: LayoutNode }) {
  return (
    <div class={styles.root} style={{ display: 'flex', width: '100%', height: '100%' }}>
      <Node node={props.root} size={1} path="" rail={false} hidden={false} />
    </div>
  );
}

/**
 * `axis`: direction of the parent split, if any. `rail`: the node is in the sidebar column. `hidden`: kept mounted but
 * not drawn (docked in a collapsed rail).
 */
function Node(props: { node: LayoutNode; size: SplitSize | undefined; axis?: 'row' | 'column'; path: SplitPath; rail: boolean; hidden: boolean }): JSX.Element {
  return (
    <Switch>
      <Match when={props.node.kind === 'split' && props.node}>
        {(split) => (
          <Split dir={split().dir} sizes={split().sizes} children={split().children} size={props.size} path={props.path} rail={props.rail} hidden={props.hidden} />
        )}
      </Match>
      <Match when={props.node.kind === 'tabs' && props.node}>
        {(tabs) => <Tabs panels={tabs().children} initial={tabs().active} size={props.size} hidden={props.hidden} />}
      </Match>
      <Match when={props.node.kind === 'panel' && props.node}>
        {(ref) => <PanelSlot panel={ref()} size={props.size} axis={props.axis} hidden={props.hidden} />}
      </Match>
    </Switch>
  );
}

/** Narrowest a panel may be dragged: room for its header and a line of content. */
const MIN_PANEL_PX = 120;
/** Keyboard resize step for a focused handle. */
const KEY_STEP_PX = 24;
/** The two slots a resize handle trades space between, at drag start: their sizes and the least each may shrink to, in px. */
interface Measured {
  px: [number, number];
  min: [number, number];
}

/** Panels that hold the sidebar: when it is collapsed, their split slot sizes to the rail instead of a share. */
const SIDEBAR_PANELS = new Set(['channels']);
const holdsSidebar = (n: LayoutNode): boolean =>
  n.kind === 'panel' ? SIDEBAR_PANELS.has(n.id) : n.kind === 'split' ? n.children.some(holdsSidebar) : false;
/** Panels drawn in the collapsed rail; any other panel docked into the sidebar column hides until it expands. */
const RAIL_PANELS = new Set(['channels', 'sync-status']);

function Split(props: {
  dir: 'row' | 'column';
  sizes: SplitSize[];
  children: LayoutNode[];
  size: SplitSize | undefined;
  path: SplitPath;
  rail: boolean;
  hidden: boolean;
}) {
  /** A child is in the sidebar column when this split is, or when it is the row slot holding the sidebar. */
  const inRail = (child: LayoutNode): boolean => props.rail || (props.dir === 'row' && holdsSidebar(child));
  const railHidden = (child: LayoutNode): boolean => sidebarCollapsed() && inRail(child) && !panelIds(child).some((id) => RAIL_PANELS.has(id));
  // Live sizes while dragging; persisted once on release.
  const [draft, setDraft] = createSignal<SplitSize[] | null>(null);
  /** Layout sizes (what dragging edits and saves). */
  const sizes = (): SplitSize[] => draft() ?? effectiveSizes(props.sizes, splitSizes(props.path));
  /** Drawn sizes preserve saved shares. Collapsed sidebars use rails; content-sized children consume no share and leave remaining space to neighbors. */
  const shown = (): SplitSize[] =>
    normalizeShares(
      sizes().map((s, i): SplitSize => {
        const child = props.children[i]!;
        if (railHidden(child)) return 'auto';
        if (props.dir === 'row' && sidebarCollapsed() && holdsSidebar(child)) return 'auto';
        return contentSized(child, props.dir, isPanelCollapsed) ? 'auto' : s;
      }),
    );
  const commit = (next: SplitSize[]): void => {
    setDraft(null);
    setSplitSizes(props.path, next.filter((s): s is number => s !== 'auto'));
  };

  /** Handle after share-sized child `a`: trades space with the next share-sized child, across any content-sized ones. */
  const handle = (a: number): JSX.Element => {
    /** Pixel sizes and minimums of `a` and `b`. Children between them are content-sized, so carry no handles. */
    const measure = (el: HTMLElement, b: number): Measured => {
      let after: Element | null = el;
      for (let k = a; k < b && after; k++) after = after.nextElementSibling;
      const before = el.previousElementSibling;
      const px = (n: Element | null): number => (n ? n.getBoundingClientRect()[props.dir === 'row' ? 'width' : 'height'] : 0);
      const min = (n: Element | null): number => Math.max(MIN_PANEL_PX, props.dir === 'column' ? fitHeight(n) : 0);
      return { px: [px(before), px(after)], min: [min(before), min(after)] };
    };
    const onPointerDown = (e: PointerEvent): void => {
      const el = e.currentTarget as HTMLElement;
      const b = nextShare(shown(), a);
      const start = measure(el, b);
      const origin = props.dir === 'row' ? e.clientX : e.clientY;
      el.setPointerCapture(e.pointerId);
      setResizing(true);
      const onMove = (m: PointerEvent): void => {
        setDraft(resizeShares(sizes(), a, b, start.px, start.min, (props.dir === 'row' ? m.clientX : m.clientY) - origin));
      };
      const onUp = (): void => {
        el.removeEventListener('pointermove', onMove);
        setResizing(false);
        const d = draft();
        if (d) commit(d);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp, { once: true });
      el.addEventListener('pointercancel', onUp, { once: true });
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      const [back, fwd] = props.dir === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (e.key !== back && e.key !== fwd) return;
      e.preventDefault();
      const b = nextShare(shown(), a);
      const start = measure(e.currentTarget as HTMLElement, b);
      commit(resizeShares(sizes(), a, b, start.px, start.min, e.key === fwd ? KEY_STEP_PX : -KEY_STEP_PX));
    };
    return (
      <div
        class={styles.handle}
        data-dir={props.dir}
        role="separator"
        aria-orientation={props.dir === 'row' ? 'vertical' : 'horizontal'}
        aria-label="Resize panels (double-click to reset)"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDblClick={() => setSplitSizes(props.path, null)}
        style={{ flex: '0 0 auto', 'touch-action': 'none' }}
      />
    );
  };

  return (
    <div class={styles.split} data-dir={props.dir} hidden={props.hidden} style={{ display: 'flex', 'flex-direction': props.dir, ...sizeStyle(props.size, props.hidden) }}>
      <For each={props.children}>
        {(child, i) => (
          <>
            {/* A handle after each share-sized child that has a share-sized one somewhere after it. */}
            <Show when={i() > 0 && shown()[i() - 1] !== 'auto' && nextShare(shown(), i() - 1) >= 0}>{handle(i() - 1)}</Show>
            <Node node={child} size={shown()[i()]} axis={props.dir} path={childPath(props.path, i())} rail={inRail(child)} hidden={railHidden(child)} />
          </>
        )}
      </For>
    </div>
  );
}

function Tabs(props: { panels: PanelRef[]; initial: number; size: SplitSize | undefined; hidden: boolean }) {
  const tabs = createTabSelection(() => props.panels, props.initial, tabPicks);
  createEffect(
    on(revealRequest, (r) => {
      if (r && props.panels.some((p) => p.id === r.id)) tabs.pick(r.id);
    }, { defer: true }),
  );
  return (
    <div class={styles.tabs} hidden={props.hidden} style={{ display: 'flex', 'flex-direction': 'column', ...sizeStyle(props.size, props.hidden) }}>
      <div class={styles.tabBar} role="tablist">
        <For each={props.panels}>
          {(p) => (
            <button
              type="button"
              role="tab"
              class={styles.tab}
              {...panelIdentity(p.id)}
              aria-selected={tabs.shown() === p.id}
              onClick={() => tabs.pick(p.id)}
            >
              {titleOf(p.id)}
            </button>
          )}
        </For>
      </div>
      <For each={props.panels}>
        {(p) => (
          <div role="tabpanel" hidden={tabs.shown() !== p.id} style={{ display: tabs.shown() === p.id ? 'flex' : 'none', flex: '1 1 0', 'min-height': 0, 'min-width': 0 }}>
            <PanelSlot panel={p} size={1} hidden={false} />
          </div>
        )}
      </For>
    </div>
  );
}
