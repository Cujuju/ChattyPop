// Plugin items in host slots (docs/plugin-architecture.md §6): what a descriptor declares for each slot, the ids the
// host stamps on them, and the check that a renderer side implements exactly those.
import {
  HOST_ATTACHMENT_ACTIONS,
  HOST_CHAT_FOOTER_ITEMS,
  HOST_HOVER_ACTIONS,
  HOST_HOVER_EMOJI_ITEMS,
  HOST_MESSAGE_MENU_GROUPS,
  HOST_PHONE_DRAWER_ITEMS,
  HOST_PHONE_SECTIONS,
  HOST_PROVIDER_ROWS,
  HOST_RULE_TEMPLATES,
  HOST_STATUS_BAR_ITEMS,
  HOST_TOP_BAR_ITEMS,
  type Placement,
} from './anchors';

/** Each host slot plugins place items in, with the host's own items there: its anchors besides plugins' items. */
export const HOST_SLOT_ITEMS = {
  topBar: HOST_TOP_BAR_ITEMS,
  statusBar: HOST_STATUS_BAR_ITEMS,
  phoneSections: HOST_PHONE_SECTIONS,
  phoneDrawer: HOST_PHONE_DRAWER_ITEMS,
  providerRows: HOST_PROVIDER_ROWS,
  messageMenu: HOST_MESSAGE_MENU_GROUPS,
  chatFooter: HOST_CHAT_FOOTER_ITEMS,
  hoverEmoji: HOST_HOVER_EMOJI_ITEMS,
  hoverActions: HOST_HOVER_ACTIONS,
  attachmentActions: HOST_ATTACHMENT_ACTIONS,
  ruleTemplates: HOST_RULE_TEMPLATES,
  personSections: [],
  personLinks: [],
} as const satisfies Record<string, readonly string[]>;
export type SlotKind = keyof typeof HOST_SLOT_ITEMS;
export const SLOT_KINDS = Object.keys(HOST_SLOT_ITEMS) as readonly SlotKind[];

/** An item's id within its plugin: an identifier without dots, so a stamped id names one plugin and one item. */
export const SLOT_LOCAL_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * An item a plugin puts in a host slot: its local id and placement. Anchors are host items' bare ids or other items'
 * stamped ids. Its view is the renderer side's under the same local id.
 */
export type SlotDecl = { id: string } & Placement;
/** A descriptor's items, by slot. */
export type SlotDecls = { readonly [K in SlotKind]?: readonly SlotDecl[] };

/** An item's id in its slot, stamped by the host: `<plugin id>.<local id>`. Host items keep their bare ids. */
export const slotId = (pluginId: string, local: string): string => `${pluginId}.${local}`;

/** A renderer side's slot views: for each slot, its views by local id. */
export type SlotViewsOf = { readonly [K in SlotKind]?: Readonly<Record<string, unknown>> };

/** Throws unless `views` has a view for exactly each item `slots` declares, so no declared item goes missing. */
export function checkSlotViews(pluginId: string, slots: SlotDecls | undefined, views: SlotViewsOf): void {
  for (const kind of SLOT_KINDS) {
    const declared = (slots?.[kind] ?? []).map((d) => d.id);
    const given = Object.keys(views[kind] ?? {});
    const missing = declared.filter((id) => !given.includes(id));
    if (missing.length) throw new Error(`${pluginId} declares ${kind} ${missing.join(', ')} but its renderer side has no view for them.`);
    const undeclared = given.filter((id) => !declared.includes(id));
    if (undeclared.length) throw new Error(`${pluginId} renders ${kind} ${undeclared.join(', ')}, which its descriptor doesn't declare.`);
  }
}
