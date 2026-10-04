import type { Accessor, JSX } from 'solid-js';
import { VirtualLog as VirtualLogCanvas } from '@cujuju/solidjs-virtual-log';
import type { VirtualLog } from './virtualLog';

/** A row's menu opened from the keyboard appears this far inside its top-left corner. */
const KEYBOARD_MENU_INSET_PX = 16;
/** Spread on the element in a row whose `contextmenu` opens the row's menu (a message): the menu key sends it there. */
const ROW_MENU_ATTR = 'data-row-menu';
export const rowMenuTarget = { [ROW_MENU_ATTR]: '' } as const;

/** Opens a row's right-click menu (on its rowMenuTarget) near the row's top-left corner; a row without one has none. */
const openRowMenu = (row: HTMLElement): void => {
  const content = row.querySelector(`[${ROW_MENU_ATTR}]`);
  if (!content) return;
  const r = content.getBoundingClientRect();
  content.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + KEYBOARD_MENU_INSET_PX, clientY: r.top + KEYBOARD_MENU_INSET_PX }));
};

/**
 * The log's canvas: each visible row placed and measured once drawn. Place inside the scroll container. One element
 * per row key, so a new row doesn't reload its neighbours' images.
 *
 * Keyboard: the log is one Tab stop (the last row focused, else the newest in view). Up/Down move a row (older rows load
 * as the top nears); the menu key or Shift+F10 opens the focused row's menu (its right-click menu), as does a
 * `contextmenu` aimed at the row itself (a screen reader's menu command).
 */
export function VirtualRows<R extends { key: string }>(props: { log: VirtualLog<R>; class?: string; children: (row: Accessor<R>) => JSX.Element }) {
  return (
    <VirtualLogCanvas log={props.log.log} class={props.class} onRowMenu={openRowMenu}>
      {props.children}
    </VirtualLogCanvas>
  );
}
