import { For, Show, createEffect, createSignal, on, type JSX } from 'solid-js';
import { contextMenu, inCompanion, setContextMenu, type ContextMenuState, type MenuGroup, type MenuItem } from '@/state/ui';
import { Icon } from './icons';
import { listen } from './listen';
import { keepOnScreen } from './keepOnScreen';
import { pullToClose } from './pullToClose';
import styles from './ContextMenu.module.css';

type SubmenuItem = Extract<MenuItem, { submenu: MenuGroup[] }>;
/** An open submenu: its item, and the row it opened from (the desktop places it beside that row). */
interface OpenSubmenu {
  item: SubmenuItem;
  row: HTMLElement;
}

/** The item's ARIA role: a plain action, a toggle, or one choice of an exclusive group. */
const roleOf = (item: MenuItem, g: MenuGroup): 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' =>
  item.checked === undefined ? 'menuitem' : g.exclusive ? 'menuitemradio' : 'menuitemcheckbox';

/** Any setting among the groups: every row keeps a mark column, so labels line up across groups. */
const anyMarked = (groups: readonly MenuGroup[]): boolean => groups.some((g) => g.items.some((i) => i.checked !== undefined));

/** The panel's rows, for arrow-key moves: its own only (a desktop submenu is a sibling panel). */
const rowsOf = (panel: HTMLElement | undefined): HTMLButtonElement[] => [...(panel?.querySelectorAll<HTMLButtonElement>(`.${styles.item}`) ?? [])];

/** Grouped menus support icons, setting marks and lead content. Desktop submenus open beside rows; phone submenus replace sheets. Choice/Escape/outside/scroll close. */
export function ContextMenu(props: { lead?: (m: ContextMenuState) => JSX.Element }) {
  let menu: HTMLDivElement | undefined;
  let subPanel: HTMLDivElement | undefined;
  const [sub, setSub] = createSignal<OpenSubmenu | null>(null);
  const close = (): void => void setContextMenu(null);
  const run = (item: MenuItem): void => {
    close();
    void item.run?.();
  };
  const inMenu = (t: EventTarget | null): boolean => t instanceof Node && (!!menu?.contains(t) || !!subPanel?.contains(t));
  /** Closes the submenu, the focus back on its row when it was inside. */
  const closeSub = (): void => {
    const s = sub();
    if (!s) return;
    const refocus = !!subPanel?.contains(document.activeElement);
    setSub(null);
    if (refocus) s.row.focus();
  };
  const openSub = (item: SubmenuItem, row: HTMLElement, focusFirst: boolean): void => {
    if (sub()?.item !== item) setSub({ item, row });
    if (focusFirst) queueMicrotask(() => rowsOf(inCompanion ? menu : subPanel)[0]?.focus());
  };
  // A new menu starts with no submenu open.
  createEffect(on(contextMenu, () => setSub(null)));

  // Closing internally focused menus restores opener focus, falling back to its nearest focusable ancestor if unmounted.
  let opener: HTMLElement | null = null;
  let openerHost: HTMLElement | null = null;
  createEffect(
    on(
      () => contextMenu() !== null,
      (open) => {
        if (open) {
          opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          openerHost = opener?.parentElement?.closest<HTMLElement>('[tabindex]') ?? null;
          return;
        }
        const [first, host] = [opener, openerHost];
        opener = null;
        openerHost = null;
        // After the close has rendered: only then is it known whether the opener survived.
        queueMicrotask(() => {
          const back = first?.isConnected ? first : host;
          if (back?.isConnected && (document.activeElement === document.body || document.activeElement === null)) back.focus({ preventScroll: true });
        });
      },
      { defer: true },
    ),
  );

  // Its area reaches the live Discord view's cover by itself (.cp-popover, ui/popoverCover).
  createEffect(() => {
    const m = contextMenu();
    if (!m || !menu || inCompanion) return;
    // Measure after render, then pull back inside the window.
    queueMicrotask(() => {
      if (!menu) return;
      keepOnScreen(menu, m.x, m.y);
      menu.querySelector<HTMLButtonElement>(`.${styles.item}`)?.focus();
    });
  });
  // Beside its row; flipped to the menu's left when the right has no room.
  createEffect(() => {
    const s = sub();
    if (!s || inCompanion) return;
    queueMicrotask(() => {
      if (!subPanel || !menu) return;
      const row = s.row.getBoundingClientRect();
      keepOnScreen(subPanel, menu.getBoundingClientRect().right, row.top, { x: menu.getBoundingClientRect().left });
    });
  });

  listen(window, 'mousedown', (e) => contextMenu() && !inMenu(e.target) && close(), true);
  listen(window, 'keydown', (e) => {
    if (!contextMenu()) return;
    const focused = document.activeElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sub()) closeSub();
      else close();
    }
    if (e.key === 'ArrowRight' && focused instanceof HTMLButtonElement && focused.getAttribute('aria-haspopup') === 'menu') {
      e.preventDefault();
      focused.click();
    }
    if (e.key === 'ArrowLeft' && sub()) {
      e.preventDefault();
      closeSub();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = rowsOf(subPanel?.contains(focused) ? subPanel : menu);
      const i = items.indexOf(focused as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  listen(window, 'blur', close);
  listen(
    window,
    'scroll',
    (e) => {
      // A tall menu scrolls itself; only scrolling elsewhere closes it.
      if (!inMenu(e.target)) close();
    },
    true,
  );

  /** A row. `cascades`: the desktop's top panel, where hovering a row opens its submenu or closes another's. */
  const row = (item: MenuItem, g: MenuGroup, cascades: boolean): JSX.Element => {
    const submenu = item.submenu ? (item as SubmenuItem) : null;
    return (
      <button
        type="button"
        role={roleOf(item, g)}
        aria-checked={item.checked}
        aria-haspopup={submenu ? 'menu' : undefined}
        aria-expanded={submenu ? sub()?.item === submenu : undefined}
        class={styles.item}
        data-mark={item.checked === undefined ? undefined : g.exclusive ? 'dot' : 'tick'}
        data-checked={item.checked}
        data-danger={item.danger}
        onClick={(e) => (submenu ? openSub(submenu, e.currentTarget, true) : run(item))}
        onPointerEnter={cascades ? (e) => (submenu ? openSub(submenu, e.currentTarget, false) : setSub(null)) : undefined}
      >
        <span class={styles.mark} aria-hidden="true" />
        <Icon name={item.icon} class={styles.icon} />
        <span class={styles.text}>
          <span class={styles.label}>{item.label}</span>
          <Show when={item.detail}>
            <span class={styles.detail}>{item.detail}</span>
          </Show>
        </span>
        <Show when={submenu}>
          <Icon name="chevronRight" class={styles.more} />
        </Show>
      </button>
    );
  };

  const groups = (list: readonly MenuGroup[], cascades: boolean): JSX.Element => (
    <For each={list}>
      {(g, i) => (
        <>
          <Show when={i() > 0}>
            <div class={styles.rule} role="separator" />
          </Show>
          <div class={styles.group} role="group" aria-label={g.heading}>
            <Show when={g.heading}>
              <div class={styles.heading} aria-hidden="true">
                {g.heading}
              </div>
            </Show>
            <For each={g.items}>{(item) => row(item, g, cascades)}</For>
          </div>
        </>
      )}
    </For>
  );

  const body = (m: ContextMenuState): JSX.Element => (
    <>
      <Show when={props.lead?.(m)}>
        {(lead) => (
          <>
            <div class={styles.lead}>{lead()}</div>
            <div class={styles.rule} role="separator" />
          </>
        )}
      </Show>
      {groups(m.groups, !inCompanion)}
    </>
  );

  /** The phone's submenu, in the sheet's place: a back row to the menu, then its groups. */
  const drilled = (s: OpenSubmenu): JSX.Element => (
    <>
      <div class={styles.group}>
        <button type="button" class={styles.item} onClick={() => setSub(null)}>
          <span class={styles.mark} aria-hidden="true" />
          <Icon name="chevronLeft" class={styles.icon} />
          <span class={styles.text}>
            <span class={styles.label}>{s.item.label}</span>
          </span>
        </button>
      </div>
      {groups(s.item.submenu, false)}
    </>
  );

  return (
    <Show when={contextMenu()} keyed>
      {(m) =>
        inCompanion ? (
          <div class={styles.backdrop}>
            <div
              ref={(el) => {
                menu = el;
                pullToClose(el, close);
              }}
              class={styles.sheet}
              role="menu"
              data-marked={anyMarked(sub()?.item.submenu ?? m.groups)}
            >
              <div class={styles.grabber} aria-hidden="true" />
              <Show when={sub()} fallback={body(m)}>
                {(s) => drilled(s())}
              </Show>
            </div>
          </div>
        ) : (
          // Position is data (the pointer, the row), set inline; the look is in ContextMenu.module.css.
          <>
            <div ref={(el) => (menu = el)} class={`cp-popover ${styles.menu}`} role="menu" data-marked={anyMarked(m.groups)} style={{ position: 'fixed', left: `${m.x}px`, top: `${m.y}px` }}>
              {body(m)}
            </div>
            <Show when={sub()} keyed>
              {(s) => (
                <div ref={(el) => (subPanel = el)} class={`cp-popover ${styles.menu}`} role="menu" aria-label={s.item.label} data-marked={anyMarked(s.item.submenu)} style={{ position: 'fixed' }}>
                  {groups(s.item.submenu, false)}
                </div>
              )}
            </Show>
          </>
        )
      }
    </Show>
  );
}
