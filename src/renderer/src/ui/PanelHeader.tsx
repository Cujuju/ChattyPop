import { Show, splitProps, type JSX } from 'solid-js';
import { movable, panelDragProps, panelMenu } from '@/layout/panelMenu';
import { isPanelCollapsed, isPlaced, setPanelCollapsed } from '@/state/layout';
import { openContextMenu, outsideLayout } from '@/state/ui';
import type { LayoutPanelId } from '@/layout/types';
import type { SectionId } from '@/panels/titles';
import { SectionIcon } from './SectionIcon';
import { look } from '@/theme/look';
import styles from './PanelHeader.module.css';

/** Shared header parts for panels: .badge (new count), .actions (trailing group), .action, .iconAction, .primary, .toggle. */
export const headerStyles = styles;

/** Shared headers collapse by panel id. Narrowing hides metadata, then tiles, then wraps actions. metaWraps preserves content metadata below titles. */
export function PanelHeader(props: {
  section: SectionId;
  /** The panel's layout id when it differs from its section (plugin panels); collapse state and the menu key on it. */
  panelId?: LayoutPanelId;
  title: JSX.Element;
  /** A control before the title (the phone's back button). */
  lead?: JSX.Element;
  meta?: JSX.Element;
  /** Wrap the meta below the title when it doesn't fit beside it, rather than hiding it. */
  metaWraps?: boolean;
  collapsible?: boolean;
  children?: JSX.Element;
}) {
  const id = (): LayoutPanelId | 'plugin' => props.panelId ?? props.section;
  // Outside the layout the header doesn't fold or open the layout menu; in the main window's in-app windows it still drags into the layout.
  const collapsible = (): boolean => Boolean(props.collapsible) && isPlaced(id());
  const collapsed = (): boolean => collapsible() && isPanelCollapsed(id());
  /** Right-click: move this panel within the layout (see panelMenu). */
  const openMenu = (e: MouseEvent): void => {
    const target = id();
    openContextMenu(e, target === 'plugin' || !isPlaced(target) ? [] : panelMenu(target));
  };
  /** Drag: drop on another panel's edge to place it there, or its middle to swap (see LayoutRoot DropZones). */
  const dragId = (): LayoutPanelId | null => {
    const target = id();
    return target !== 'plugin' && !outsideLayout && movable(target) ? target : null;
  };
  return (
    <div class={styles.frame}>
      <header class={styles.header} data-section={props.section} data-panel-color={props.panelId ?? props.section} data-collapsed={collapsed()} {...panelDragProps(dragId)} onContextMenu={openMenu}>
        <SectionIcon section={props.section} />
        {props.lead}
        <div class={styles.titleGroup} data-meta-wraps={Boolean(props.metaWraps)}>
          <h2 class={styles.title}>
            <Show when={collapsible()} fallback={props.title}>
              <button type="button" class={styles.toggle} aria-expanded={!collapsed()} onClick={() => setPanelCollapsed(id(), !collapsed())}>
                {props.title}
                <span class={`cp-chevron ${styles.chevron}`} aria-hidden="true" />
              </button>
            </Show>
          </h2>
          <Show when={props.meta}>
            <span class={styles.meta}>{props.meta}</span>
          </Show>
        </div>
        {props.children}
      </header>
    </div>
  );
}

/** The header's action group: pushed to the end of whichever line it lands on, or centred in the run after the title. */
export const HeaderActions = (props: { children: JSX.Element; align?: 'end' | 'center' }) => (
  <div class={styles.actions} data-align={props.align ?? 'end'}>
    {props.children}
  </div>
);

/** How a header button reads: a ghost text button, a ghost icon button, or the app's one primary action, as text or as an icon alone. */
export type HeaderButtonVariant = 'text' | 'icon' | 'primary' | 'primaryIcon';
const HEADER_BUTTON_CLASS: Record<HeaderButtonVariant, string | undefined> = {
  text: styles.action,
  icon: styles.iconAction,
  primary: styles.primary,
  primaryIcon: styles.primaryIcon,
};

/** A header button (default `text`). Every other attribute passes through; `aria-pressed='true'` reads as a raised toggle. */
export function HeaderButton(props: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'type'> & { variant?: HeaderButtonVariant }) {
  const [own, rest] = splitProps(props, ['variant']);
  return <button type="button" {...rest} class={HEADER_BUTTON_CLASS[own.variant ?? 'text']} />;
}

/** The 'N new' pill in the section colour; with `onClick`, a button (e.g. marking them read). */
export function HeaderBadge(props: { children: JSX.Element; title?: string; onClick?: () => void }) {
  return (
    <Show when={props.onClick} fallback={<span class={styles.badge} title={props.title}>{props.children}</span>}>
      {(click) => (
        <button type="button" class={`${styles.badge} ${look.badgeButton}`} title={props.title} onClick={() => click()()}>
          {props.children}
        </button>
      )}
    </Show>
  );
}

/** A muted note among the header's actions (a cost estimate). */
export const HeaderMeta = (props: { children: JSX.Element; title?: string }) => (
  <span class={styles.meta} title={props.title}>
    {props.children}
  </span>
);
