// What the phone may reach, whatever transport carries it (docs/plugin-architecture.md §3, phone points).
import { isPluginPreference, phoneGetsEvent, phoneMayCall } from './bundledPlugins';
import type { RendererApi, RendererCoreMethod } from './rendererApi';
import { SETTINGS_KEYS } from './settings';
import { APP_RESTART_CHANNEL, MAIN_INVOKE, type AppEvent } from './types/ipc';

/** Core calls the phone may make: archive reads, its own writes and Settings' calls. Plugin audiences govern feature calls; settings use phoneSetting and phoneMayWriteSetting. */
export const PHONE_CORE_METHODS = [
  'status',
  'getSetting',
  'directory',
  'channelUnread',
  'channelUnreadSnapshot',
  // Settings → New-message counts lists these bots on the phone too.
  'archivedBots',
  'markChannelRead',
  'syncState',
  'aiStatus',
  'aiPlanUsage',
  'aiUsageSince',
  'jevStatus',
  'jevSpend',
  'jevQueryOverrides',
  'messagePage',
  'messageById',
  'searchMessages',
  'rankSearch',
  'personProfile',
  'discordProfile',
  'mutualFriends',
  'reactors',
  'findPeople',
  'peopleByIds',
  'personNames',
  'mentionCandidates',
  'conversation',
  'ownEmoji',
  'ownReactions',
  'ownCommands',
  'rules',
  'ruleRuns',
  'lastSeenAt',
  'plugins',
  // The owner's own Discord id: their messages are theirs to edit, their typing isn't shown to them.
  'selfId',
  // Settings → Rules.
  'createRule',
  'updateRule',
  'deleteRule',
  'patternPreview',
  // Settings → Plugins.
  'setPluginEnabled',
  'reloadPlugins',
  'runPluginCommand',
  'absentPlugins',
  // Settings → AI and Jev: keys are listed without their secrets; Jev queries are edited and rerun.
  'openRouterKeys',
  'openRouterBalances',
  'setJevQuery',
  'jevRerunCount',
  'jevRerun',
] as const satisfies readonly RendererCoreMethod[];

/** Discord calls the phone may make: posting from the Archive composer and its pickers. */
export const PHONE_DISCORD_METHODS = ['send', 'edit', 'deleteMessage', 'forward', 'react', 'gifs', 'expressions', 'commands', 'runCommand', 'autocomplete', 'useComponent', 'submitModal', 'roles', 'requestMembers', 'createThread', 'sendDirect', 'profile', 'mutualFriends', 'reactors'] as const satisfies readonly (keyof RendererApi['discord'])[];
export type PhoneDiscordMethod = (typeof PHONE_DISCORD_METHODS)[number];

/** Main's calls the phone may make (main/ipc/mainCalls.ts), all for Settings. Those needing the PC's screen (dialogs, sign-in in its browser) stay there. */
export const PHONE_MAIN_CALLS: readonly string[] = [
  MAIN_INVOKE.openRouter.addKey,
  MAIN_INVOKE.openRouter.updateKey,
  MAIN_INVOKE.openRouter.removeKey,
  MAIN_INVOKE.typeSafe.setKey,
  MAIN_INVOKE.typeSafe.removeKey,
  MAIN_INVOKE.discord.customTheme,
  MAIN_INVOKE.storage.info,
  MAIN_INVOKE.storage.setEncrypted,
  MAIN_INVOKE.desktop.state,
  MAIN_INVOKE.desktop.set,
  MAIN_INVOKE.desktop.setOpenAtLogin,
  MAIN_INVOKE.desktop.checkForUpdate,
  MAIN_INVOKE.desktop.installUpdate,
  ...Object.values(MAIN_INVOKE.marketplace),
  APP_RESTART_CHANNEL,
];
const mainCalls = new Set(PHONE_MAIN_CALLS);
/** Whether the phone may make main call `channel` (PHONE_MAIN_CALLS). */
export const phoneMayCallMain = (channel: string): boolean => mainCalls.has(channel);

/** Events the phone's stores use. Main's own work orders (plugins' posts and replies, audio fetches) never leave the PC. */
export const PHONE_EVENT_TYPES = [
  'archive-changed',
  'sync-progress',
  'opt-in-changed',
  'dm-activity',
  'read-states-changed',
  // A read mark moved (on any surface): counts are read again.
  'channel-read',
  // Another account signed in: the directory (its DMs) is read again.
  'self-changed',
  'privacy-changed',
  'rules-changed',
  'message-labels-changed',
  'setting-changed',
  'jev-spend',
  'plugins-changed',
  'attachment-notes-changed',
  'typing',
  // Settings → Desktop and Archive → Location show these.
  'desktop-changed',
  'storage-move',
] as const satisfies readonly AppEvent['type'][];
const coreMethods = new Set<string>(PHONE_CORE_METHODS);
const eventTypes = new Set<string>(PHONE_EVENT_TYPES);

/**
 * How the phone shares a host setting. 'config': read whole and written, so Settings on the phone edits the PC's.
 * 'view': read whole; the phone's own changes stay on the phone for the visit (its layout, its density).
 */
export type PhoneSettingShare = 'config' | 'view';

/** Every host setting the phone shares, and how; PHONE_UNSHARED_SETTINGS lists the rest (a test holds the two to SETTINGS_KEYS). */
export const PHONE_HOST_SETTINGS: Readonly<Record<string, PhoneSettingShare>> = {
  [SETTINGS_KEYS.ai]: 'config',
  [SETTINGS_KEYS.archive]: 'config',
  [SETTINGS_KEYS.countedBots]: 'config',
  [SETTINGS_KEYS.notifications]: 'config',
  [SETTINGS_KEYS.jevQueries]: 'config',
  // The transport's per-phone look stands in for its theme; writes keep the PC's (phoneLookWrite).
  [SETTINGS_KEYS.appearance]: 'config',
  [SETTINGS_KEYS.savedSearches]: 'config',
  [SETTINGS_KEYS.leaderKey]: 'config',
  [SETTINGS_KEYS.shortcutBindings]: 'config',
  [SETTINGS_KEYS.pluginsRestore]: 'config',
  // Showing what is hidden on the phone must not unhide it on the PC.
  [SETTINGS_KEYS.privacyMode]: 'view',
  [SETTINGS_KEYS.searchSort]: 'view',
  [SETTINGS_KEYS.discordSidebar]: 'view',
  // A phone's own density is its look (phoneLook.ts).
  [SETTINGS_KEYS.archiveDensity]: 'view',
  // Which panels are placed and folded decides whether a panel shows its body, on the phone as on the desktop.
  [SETTINGS_KEYS.layoutPreset]: 'view',
  [SETTINGS_KEYS.layoutCustom]: 'view',
  [SETTINGS_KEYS.layoutCollapsedPanels]: 'view',
  [SETTINGS_KEYS.layoutSidebarCollapsed]: 'view',
};

/** Host settings that are one window's own place (open tabs, filters, recent channels): the phone neither reads nor writes the PC's. */
export const PHONE_UNSHARED_SETTINGS: readonly string[] = [
  SETTINGS_KEYS.layoutTabPicks,
  SETTINGS_KEYS.channelsBrowsing,
  SETTINGS_KEYS.dmFilter,
  SETTINGS_KEYS.settingsTab,
  SETTINGS_KEYS.settingsSections,
  SETTINGS_KEYS.jevView,
  SETTINGS_KEYS.jevQuery,
  SETTINGS_KEYS.newMessageArchive,
  SETTINGS_KEYS.rulesFilter,
  SETTINGS_KEYS.jevQuerySearch,
  SETTINGS_KEYS.jevQueryFilter,
  SETTINGS_KEYS.recentChannels,
  SETTINGS_KEYS.chatSource,
  SETTINGS_KEYS.archiveChannel,
];

/** How the phone shares setting `key`: a host setting's PHONE_HOST_SETTINGS entry; every plugin preference is config. */
const phoneShare = (key: string): PhoneSettingShare | undefined =>
  Object.hasOwn(PHONE_HOST_SETTINGS, key) ? PHONE_HOST_SETTINGS[key] : isPluginPreference(key) ? 'config' : undefined;

/**
 * Whether the phone's write of setting `key` reaches the PC. Its stores normalize before writing and on reading, as
 * the desktop's do, so main stores the value as sent.
 */
export const phoneMayWriteSetting = (key: string): boolean => phoneShare(key) === 'config';

/** What the phone reads of setting `key` holding `value`: all of it when shared, else undefined (unset). */
export const phoneSetting = (key: string, value: unknown): unknown => (phoneShare(key) ? value : undefined);

/** Filters phone host/plugin events by type/audience; a setting's change reaches it when the setting is shared. Unavailable events return null. */
export function phoneAppEvent(e: AppEvent): AppEvent | null {
  if (e.type === 'plugin-event') return phoneGetsEvent(e.pluginId, e.name) ? e : null;
  if (!eventTypes.has(e.type)) return null;
  if (e.type !== 'setting-changed') return e;
  return phoneShare(e.key) ? e : null;
}

/** A core call the phone may make (PHONE_CORE_METHODS). Plugin calls go through the 'plugins' group, stamped 'phone'. */
export const phoneMayCallCore = (method: string): boolean => coreMethods.has(method);

/** Whether an event reaches the phone (phoneAppEvent). */
export const phoneGetsAppEvent = (e: AppEvent): boolean => phoneAppEvent(e) !== null;

/** Whether the phone may make this plugin core call (its declared audiences). */
export { phoneMayCall as phoneMayCallPlugin };

/** A call as the phone sends it: `core` methods, a plugin's `callCore`, a Discord method, or a `main` call by channel. */
export type PhoneCallGroup = 'core' | 'discord' | 'plugins' | 'main';
export interface PhoneCall {
  group: PhoneCallGroup;
  method: string;
  params: unknown[];
}

/** A phone call that got no answer from the desktop (no network, or a proxy found no app behind it): it may not have run. */
export class DesktopUnreachableError extends Error {
  override name = 'DesktopUnreachableError';
  constructor() {
    super('Can’t reach the desktop.');
  }
}

/** Dispatched on `window` when a phone page's event stream (re)connects to the desktop. */
export const DESKTOP_CONNECTED_EVENT = 'chattypop:desktop-connected';
