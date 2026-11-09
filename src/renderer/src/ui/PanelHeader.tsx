import { Show, createContext, splitProps, useContext, type JSX } from 'solid-js';
import { TabStrip } from '@cujuju/solidjs-tiling-window-manager';
import { panelMenu, titleOf } from '@/layout/panelMenu';
import { useTile } from '@/layout/tileContext';
import { canFoldPanel, isPanelCollapsed, isPlaced, setPanelCollapsed } from '@/state/layout';
import { openContextMenu } from '@/state/ui';
import type { LayoutPanelId } from '@/layout/types';
import { sectionOf, type SectionId } from '@/panels/titles';
import { SectionGlyph, SectionIcon } from './SectionIcon';
import { look } from '@/theme/look';
import styles from './PanelHeader.module.css';

/** Shared header parts for panels: .badge (new count), .actions (trailing group), .action, .iconAction, .primary, .toggle. */
export const headerStyles = styles;

/** True inside a window whose own title bar names the panel (an in-app panel window): the header drops its icon and title. */
export const TitledByWindow = createContext(false);

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
  const titledByWindow = useContext(TitledByWindow);
  /** The layout tile showing this panel: the header is its grip and tab target, and shows its tab group. Null outside the layout. */
  const tile = useTile();
  const id = (): LayoutPanelId | 'plugin' => props.panelId ?? props.section;
  // Outside the layout the header doesn't fold or open the layout menu.
  const collapsible = (): boolean => Boolean(props.collapsible) && isPlaced(id()) && canFoldPanel(id());
  const collapsed = (): boolean => collapsible() && isPanelCollapsed(id());
  /** Right-click: the panel's layout menu (see panelMenu). */
  const openMenu = (e: MouseEvent): void => {
    const target = id();
    openContextMenu(e, target === 'plugin' || !isPlaced(target) ? [] : panelMenu(target));
  };
  const tabs = () => (tile?.tabs() ? tile : null);
  return (
    <div class={styles.frame}>
      <header
        class={styles.header}
        data-section={props.section}
        data-panel-color={props.panelId ?? props.section}
        data-collapsed={collapsed()}
        data-grip={tile ? '' : undefined}
        data-twm-tab-target={tile ? '' : undefined}
        onPointerDown={(e) => tile?.startMove(e)}
        onContextMenu={openMenu}
      >
        <Show
          when={tabs()}
          fallback={
            <>
              <Show when={!titledByWindow}>
                <SectionIcon section={props.section} />
              </Show>
              {props.lead}
              <Show when={!titledByWindow || props.meta}>
                <div class={styles.titleGroup} data-meta-wraps={Boolean(props.metaWraps)}>
                  <Show when={!titledByWindow}>
                    <h2 class={styles.title}>
                      <Show when={collapsible()} fallback={props.title}>
                        <button type="button" class={styles.toggle} aria-expanded={!collapsed()} onClick={() => setPanelCollapsed(id(), !collapsed())}>
                          {props.title}
                          <span class={`cp-chevron ${styles.chevron}`} aria-hidden="true" />
                        </button>
                      </Show>
                    </h2>
                  </Show>
                  <Show when={props.meta}>
                    <span class={styles.meta}>{props.meta}</span>
                  </Show>
                </div>
              </Show>
            </>
          }
        >
          {(group) => (
            // In a tab group the strip names every tab; dragging a tab off it docks that panel elsewhere.
            <TabStrip class={styles.tabStrip} tile={group()} label={titleOf} icon={(tab) => <SectionGlyph section={sectionOf(tab)} class={styles.tabIcon} />} />
          )}
        </Show>
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
