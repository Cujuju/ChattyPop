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

/** Measures keyed virtual rows inside scrollers. One Tab stop supports arrows/loading older rows and keyboard/contextmenu row menus. */
export function VirtualRows<R extends { key: string }>(props: { log: VirtualLog<R>; class?: string; children: (row: Accessor<R>) => JSX.Element }) {
  return (
    <VirtualLogCanvas log={props.log.log} class={props.class} onRowMenu={openRowMenu}>
      {props.children}
    </VirtualLogCanvas>
  );
}
