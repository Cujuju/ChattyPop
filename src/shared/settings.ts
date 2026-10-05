// Settings schema shared by core (reads) and renderer (edits). Stored JSON is normalized on read,
// so a missing or older value always yields a complete, valid object.
import { bool, clampInt, isObj, oneOf, stringsOr } from './normalize';

export * from './aiSettings';
export * from './archiveSettings';

export const SETTINGS_KEYS = {
  ai: 'ai',
  archive: 'archive',
  discordSidebar: 'discordSidebar',
  notifications: 'notifications',
  /** The owner's edits to built-in Jev queries, by query id (Settings → Jev → Queries). */
  jevQueries: 'jevQueries',
  appearance: 'appearance',
  /** JSON true while privacy mode hides marked servers and channels; the hidden_channels view reads this key. */
  privacyMode: 'privacyMode',
  /** Saved archive searches: query strings in the owner's order (normalizeSavedSearches). */
  savedSearches: 'savedSearches',
  /** Archive search results' order (normalizeSearchSort). */
  searchSort: 'search.sort',
  /** The Archive's row density (state/archive.ts). */
  archiveDensity: 'archive.density',
  /** The chosen panel layout, the owner's own layouts, folded panels and the folded sidebar (state/layout.ts). */
  layoutPreset: 'layout.preset',
  layoutCustom: 'layout.custom',
  layoutCollapsedPanels: 'layout.collapsedPanels',
  layoutSidebarCollapsed: 'layout.sidebarCollapsed',
  /** Panels picked in tab groups, most recent first (state/layout.ts). */
  layoutTabPicks: 'layout.tabPicks',
  /** Servers mode lists every server to choose channels (state/layout.ts). */
  channelsBrowsing: 'channels.browsing',
  /** The DM list's filter (state/dms.ts). */
  dmFilter: 'dms.filter',
  /** Settings' open tab, and each page's open section (state/ui.ts). */
  settingsTab: 'settings.tab',
  settingsSections: 'settings.sections',
  /** Settings → Jev: its view and open query (state/jevNavigation.ts). */
  jevView: 'jev.view',
  jevQuery: 'jev.query',
  /** The New message window's archive choice (state/newMessage.ts). */
  newMessageArchive: 'newMessage.archive',
  /** List filters: rules (state/rules.ts) and Jev queries (state/jevNavigation.ts). */
  rulesFilter: 'rules.filter',
  jevQuerySearch: 'jev.querySearch',
  jevQueryFilter: 'jev.queryFilter',
  /** The key pressed before every app shortcut (renderer state/leaderRules.ts). */
  leaderKey: 'shortcuts.leader',
  /** The owner's shortcut keys by shortcut id, over the declared ones (renderer state/shortcutBindings.ts). */
  shortcutBindings: 'shortcuts.bindings',
  /** Channel ids the Chat area showed, most recent first (renderer state/channelRecents.ts). */
  recentChannels: 'channels.recent',
  /** What the Chat area shows, live client or Archive (renderer state/chat.ts). */
  chatSource: 'chat.source',
  /** The channel the Archive view last opened (renderer state/archive.ts). */
  archiveChannel: 'archive.channel',
} as const;

/** The Chat area's sources (SETTINGS_KEYS.chatSource). */
export const CHAT_SOURCES = ['live', 'archive'] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];
export const DEFAULT_CHAT_SOURCE: ChatSource = 'live';
export const normalizeChatSource = (v: unknown): ChatSource => oneOf(CHAT_SOURCES, v, DEFAULT_CHAT_SOURCE);

/** Built-in themes: each id is a `data-theme` value the renderer's theme CSS styles. */
export const BUILT_IN_THEME_IDS = ['night', 'spotlight', 'tide', 'paper', 'daylight'] as const;
export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];
/** App themes (Settings → Appearance). 'custom' is the owner's gradient (AppearanceSettings.custom) over a built-in base. */
export const THEME_IDS = [...BUILT_IN_THEME_IDS, 'custom'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
/** Each theme's name, as Settings → Appearance and the phone's Settings show it. */
export const THEME_LABELS: Readonly<Record<ThemeId, string>> = {
  night: 'Night Console',
  spotlight: 'Spotlight',
  tide: 'Tide',
  paper: 'Paper',
  daylight: 'Daylight',
  custom: 'Custom gradient',
};

/** A custom theme's base: dark or light grounds and text, as Discord's custom themes choose. */
export const CUSTOM_THEME_BASES = ['dark', 'light'] as const;
export type CustomThemeBase = (typeof CUSTOM_THEME_BASES)[number];
/** The built-in theme a custom base draws on for every token it doesn't derive (sections, platforms, type, sizes). */
export const CUSTOM_BASE_THEME: Readonly<Record<CustomThemeBase, BuiltInThemeId>> = { dark: 'night', light: 'daylight' };

/** Gradient stops a custom theme holds: a CSS gradient needs two; Discord's custom themes hold up to five. */
export const CUSTOM_THEME_MIN_COLORS = 2;
export const CUSTOM_THEME_MAX_COLORS = 5;
/** Base mix, in percent: how much of the base colour veils the gradient (Discord's `base_mix`). */
export const CUSTOM_THEME_MAX_MIX = 100;
export const DEGREES_PER_TURN = 360;

/** The owner's gradient theme, in Discord's own terms so a Discord custom theme imports as is. */
export interface CustomTheme {
  /** Gradient stops, `#rrggbb`, in order. */
  colors: string[];
  /** CSS linear-gradient angle in degrees. */
  angle: number;
  /** Percent of the base colour over the gradient: 0 shows the gradient bare, 100 hides it. */
  baseMix: number;
  base: CustomThemeBase;
}

/** Night Console's ground and accent as a starting gradient, until the owner picks or imports one. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = { colors: ['#090b10', '#2b3242'], angle: 180, baseMix: 70, base: 'dark' };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** A saved picker colour: hex, with alpha when the owner set opacity. */
const SAVED_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function normalizeCustomTheme(v: unknown): CustomTheme {
  if (!isObj(v)) return DEFAULT_CUSTOM_THEME;
  const colors = Array.isArray(v['colors']) ? v['colors'].filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c)).map((c) => c.toLowerCase()) : [];
  return {
    colors: colors.length >= CUSTOM_THEME_MIN_COLORS ? colors.slice(0, CUSTOM_THEME_MAX_COLORS) : DEFAULT_CUSTOM_THEME.colors,
    angle: clampInt(v['angle'], 0, DEGREES_PER_TURN - 1, DEFAULT_CUSTOM_THEME.angle),
    baseMix: clampInt(v['baseMix'], 0, CUSTOM_THEME_MAX_MIX, DEFAULT_CUSTOM_THEME.baseMix),
    base: oneOf(CUSTOM_THEME_BASES, v['base'], DEFAULT_CUSTOM_THEME.base),
  };
}

/** The Archive's message layouts (SETTINGS_KEYS.archiveDensity). Cozy: avatars and author groups. Compact: one line each. */
export const ARCHIVE_DENSITIES = ['cozy', 'compact'] as const;
export type ArchiveDensity = (typeof ARCHIVE_DENSITIES)[number];
export const DEFAULT_ARCHIVE_DENSITY: ArchiveDensity = 'cozy';
export const normalizeArchiveDensity = (v: unknown): ArchiveDensity => oneOf(ARCHIVE_DENSITIES, v, DEFAULT_ARCHIVE_DENSITY);

export interface AppearanceSettings {
  theme: ThemeId;
  /** The gradient theme 'custom' draws; kept while another theme is chosen. */
  custom: CustomTheme;
  /** The owner's colour for a panel (its header, stripe and toolbar button), `#rrggbb` by panel id, in every theme. */
  panelColors: Record<string, string>;
  /** Colours the owner saved in the colour picker, offered in every picker. */
  savedColors: string[];
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = { theme: 'night', custom: DEFAULT_CUSTOM_THEME, panelColors: {}, savedColors: [] };

/** A panel id as a colour key: also a CSS attribute value the panel colours' rules quote. */
const PANEL_COLOR_KEY = /^[\w:-]+$/;

const normalizePanelColors = (v: unknown): Record<string, string> =>
  isObj(v)
    ? Object.fromEntries(
        Object.entries(v).flatMap(([id, c]) => (PANEL_COLOR_KEY.test(id) && typeof c === 'string' && HEX_COLOR.test(c) ? [[id, c.toLowerCase()]] : [])),
      )
    : {};

export const normalizeAppearanceSettings = (v: unknown): AppearanceSettings => ({
  theme: oneOf(THEME_IDS, isObj(v) ? v['theme'] : undefined, DEFAULT_APPEARANCE_SETTINGS.theme),
  custom: normalizeCustomTheme(isObj(v) ? v['custom'] : undefined),
  panelColors: normalizePanelColors(isObj(v) ? v['panelColors'] : undefined),
  savedColors: isObj(v) && Array.isArray(v['savedColors']) ? v['savedColors'].filter((c): c is string => typeof c === 'string' && SAVED_COLOR.test(c)) : [],
});

/** The built-in theme whose CSS a setting wears: itself, or a custom theme's base. */
export const builtInTheme = (a: Pick<AppearanceSettings, 'theme' | 'custom'>): BuiltInThemeId => (a.theme === 'custom' ? CUSTOM_BASE_THEME[a.custom.base] : a.theme);

/** Servers and channels whose notices reach no device; a channel covers its threads. Alerts still records them. */
export interface MutedPlaces {
  guildIds: string[];
  channelIds: string[];
}

export interface NotificationSettings {
  /** Windows notifications for live alerts and plugins. Off: alerts still land in the inbox. */
  desktop: boolean;
  muted: MutedPlaces;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { desktop: true, muted: { guildIds: [], channelIds: [] } };

const ids = stringsOr<string[]>([]);

export const normalizeNotificationSettings = (v: unknown): NotificationSettings => {
  const muted = isObj(v) && isObj(v['muted']) ? v['muted'] : {};
  return {
    desktop: bool(isObj(v) ? v['desktop'] : undefined, DEFAULT_NOTIFICATION_SETTINGS.desktop),
    muted: { guildIds: ids(muted['guildIds']), channelIds: ids(muted['channelIds']) },
  };
};

/** Live Discord client columns: servers hidden outright; channels collapsed to an edge that opens on hover. */
export interface DiscordSidebar {
  serversHidden: boolean;
  channelsCollapsed: boolean;
}

export const DEFAULT_DISCORD_SIDEBAR: DiscordSidebar = { serversHidden: false, channelsCollapsed: false };

export function normalizeDiscordSidebar(v: unknown): DiscordSidebar {
  const src = isObj(v) ? v : {};
  return {
    serversHidden: bool(src['serversHidden'], DEFAULT_DISCORD_SIDEBAR.serversHidden),
    channelsCollapsed: bool(src['channelsCollapsed'], DEFAULT_DISCORD_SIDEBAR.channelsCollapsed),
  };
}
