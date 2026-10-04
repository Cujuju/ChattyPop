// Context-menu item and group contracts, independent of renderer state.
import type { IconName } from './iconNames';

/** What choosing an action item does. */
export type MenuRun = () => void | Promise<void>;

interface MenuItemBase {
  label: string;
  /** Drawn at the row's end, as Discord's menus do: every row has one. */
  icon: IconName;
  /** A setting's state, marked beside the label (a tick; a dot in an `exclusive` group). Undefined: not a setting. */
  checked?: boolean;
  /** What the item means or affects, dimmed on a second line. */
  detail?: string;
  /** Deletes something: drawn in the danger colour. */
  danger?: boolean;
}
/** An action, or a row opening a submenu of its own groups (beside it on the desktop, in its place on the phone). */
export type MenuItem = MenuItemBase & ({ run: MenuRun; submenu?: never } | { submenu: MenuGroup[]; run?: never });
/** Related items; the menu separates groups with a rule. */
export interface MenuGroup {
  /** Names what the items act on or choose between; they then read as its options ("Swap with" → panel names). */
  heading?: string;
  /** Exactly one item is checked: they are choices of one setting. */
  exclusive?: boolean;
  items: MenuItem[];
}
