// Shared placement ordering and host slot anchors.

/** Built-in panels, in the top bar's order (renderer panels/titles.ts PANEL_TITLES). */
export const HOST_PANELS = ['channels', 'sync-status', 'chat', 'status-bar'] as const;
export type HostPanelId = (typeof HOST_PANELS)[number];

/** Settings tabs (renderer SettingsDialog). */
export const HOST_SETTINGS_TABS = ['rules', 'plugins', 'ai', 'jev', 'archive', 'notifications', 'desktop', 'appearance'] as const;
export type HostSettingsTabId = (typeof HOST_SETTINGS_TABS)[number];

/** Settings tabs whose page takes plugin sections. */
export const HOST_SETTINGS_PAGES = ['ai', 'archive'] as const satisfies readonly HostSettingsTabId[];
export type SettingsPageId = (typeof HOST_SETTINGS_PAGES)[number];

/**
 * Keyboard shortcuts (renderer state/shortcuts.ts), in the status bar's hint order, each with its default keys after the
 * leader key; the owner rebinds all but layout's fixed digits (state/shortcutBindings.ts). Layout's digits pick presets in the top bar's order; the switcher's key is the leader itself, pressed twice.
 * A plugin's shortcut is one other lowercase letter.
 */
export const HOST_SHORTCUTS = {
  layout: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  live: ['a'],
  search: ['/'],
  switcher: [],
  back: ['Tab'],
} as const satisfies Record<string, readonly string[]>;
export type HostShortcutId = keyof typeof HOST_SHORTCUTS;

/** Settings → Rules → New rule templates (renderer NewRule). */
export const HOST_RULE_TEMPLATES = ['links'] as const;
export type HostRuleTemplateId = (typeof HOST_RULE_TEMPLATES)[number];

/** Fixed message-menu groups, including groups whose items may be empty; `delete` is always empty, an anchor. */
export const HOST_MESSAGE_MENU_GROUPS = ['selection', 'views', 'copy', 'jev', 'delete'] as const;
export type HostMessageMenuGroupId = (typeof HOST_MESSAGE_MENU_GROUPS)[number];

/** The Archive view's footer under the log: the message box. */
export const HOST_CHAT_FOOTER_ITEMS = ['composer'] as const;
export type HostChatFooterItemId = (typeof HOST_CHAT_FOOTER_ITEMS)[number];

/** The message hover bar's reaction group: quick reactions and Add reaction. */
export const HOST_HOVER_EMOJI_ITEMS = ['reactions'] as const;
export type HostHoverEmojiItemId = (typeof HOST_HOVER_EMOJI_ITEMS)[number];

/** Anchors in the message hover bar, between its reaction group and More, in order; the host draws nothing at them. */
export const HOST_HOVER_ACTIONS = ['edit', 'reply', 'forward'] as const;
export type HostHoverActionId = (typeof HOST_HOVER_ACTIONS)[number];
/** A hovered attachment's bar, in order: anchors modify and delete (the host draws nothing at them), then Download. */
export const HOST_ATTACHMENT_ACTIONS = ['modify', 'delete', 'download'] as const;
export type HostAttachmentActionId = (typeof HOST_ATTACHMENT_ACTIONS)[number];

/** Fixed items in the top bar's end group. */
export const HOST_TOP_BAR_ITEMS = ['layout', 'privacy', 'settings'] as const;
export type HostTopBarItemId = (typeof HOST_TOP_BAR_ITEMS)[number];

/** Fixed status-bar items, including conditionally empty items. */
export const HOST_STATUS_BAR_ITEMS = ['capture', 'backfill', 'error', 'disk', 'jev', 'hints', 'restart', 'version'] as const;
export type HostStatusBarItemId = (typeof HOST_STATUS_BAR_ITEMS)[number];

/** Companion panes; Archive appears through the drawer's channels instead of a section row. */
export const HOST_PHONE_SECTIONS = ['archive'] as const;
export type HostPhoneSectionId = (typeof HOST_PHONE_SECTIONS)[number];

/** Companion drawer panes below the section list, in order. */
export const HOST_PHONE_DRAWER_ITEMS = ['channels'] as const;
export type HostPhoneDrawerItemId = (typeof HOST_PHONE_DRAWER_ITEMS)[number];

/** Rows of a provider's card in Settings → AI, in order; `rows` are the provider plugin's own (an address). */
export const HOST_PROVIDER_ROWS = ['enabled', 'model', 'effort', 'plan-usage', 'rows'] as const;
export type HostProviderRowId = (typeof HOST_PROVIDER_ROWS)[number];

/** Placement relative to another item; a string means after. */
export type PlacementAnchor = string | { before: string };

/** One placement direction: after or before a host item or another plugin's item; neither appends. */
export type Placement = { after?: string; before?: never } | { before: string; after?: never };

/** A placement as the ordering function reads it; undefined appends. */
export const placementAnchor = (p: Placement): PlacementAnchor | undefined => (p.before !== undefined ? { before: p.before } : p.after);

/** Places extras before or after anchors, follows absent anchors' placements, and appends unknown anchors. Shared anchors retain declaration order. */
export function placeByAnchor<T>(host: readonly T[], extra: readonly T[], idOf: (t: T) => string, anchorOf: (id: string) => PlacementAnchor | undefined): T[] {
  const present = new Set([...host, ...extra].map(idOf));
  const resolve = (id: string): PlacementAnchor | undefined => {
    const seen = new Set<string>();
    let a = anchorOf(id);
    while (a !== undefined) {
      const target = typeof a === 'string' ? a : a.before;
      if (present.has(target)) return a;
      if (seen.has(target)) return undefined;
      seen.add(target);
      a = anchorOf(target);
    }
    return undefined;
  };
  const after = new Map<string | undefined, T[]>();
  const before = new Map<string, T[]>();
  for (const t of extra) {
    const a = resolve(idOf(t));
    if (typeof a === 'object') before.set(a.before, [...(before.get(a.before) ?? []), t]);
    else after.set(a, [...(after.get(a) ?? []), t]);
  }
  const out: T[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (t: T): void => {
    const id = idOf(t);
    if (visiting.has(id)) throw new Error(`Placement loops through ${id}`);
    if (placed.has(id)) return;
    visiting.add(id);
    for (const next of before.get(id) ?? []) place(next);
    out.push(t);
    for (const next of after.get(id) ?? []) place(next);
    visiting.delete(id);
    placed.add(id);
  };
  host.forEach(place);
  (after.get(undefined) ?? []).forEach(place);
  extra.forEach(place);
  return out;
}

/**
 * Throws on an undeclared anchor or a looping chain (checkBundled). `absent` anchors name unloaded plugins:
 * placeByAnchor appends their items. Only `checked` items are checked; chains span all `items`.
 */
export function checkAnchors(
  items: ReadonlyMap<string, string | undefined>,
  known: ReadonlySet<string>,
  what: string,
  absent: (anchor: string) => boolean,
  checked: ReadonlySet<string> = new Set(items.keys()),
): void {
  for (const [id, first] of items) {
    if (!checked.has(id)) continue;
    const seen = new Set([id]);
    for (let a: string | undefined = first; a !== undefined && !known.has(a); a = items.get(a)) {
      if (!items.has(a)) {
        if (absent(a)) break;
        throw new Error(`${what} ${id} follows ${first}, which no plugin provides`);
      }
      if (seen.has(a)) throw new Error(`${what} ${id}: its placement loops through ${a}`);
      seen.add(a);
    }
  }
}
