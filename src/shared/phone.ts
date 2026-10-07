// What the phone may reach, whatever transport carries it (docs/plugin-architecture.md §3, phone points).
import { phoneGetsEvent, phoneMayCall, pluginPhoneSetting } from './bundledPlugins';
import type { PhoneSettingView } from './bundledTypes';
import { isObj } from './normalize';
import type { RendererApi, RendererCoreMethod } from './rendererApi';
import { SETTINGS_KEYS, normalizeCountedBots } from './settings';
import type { AppEvent } from './types/ipc';

/** Phone allows archive reads and requested search writes. Plugin audiences govern feature calls; keys/rules remain desktop-only; settings use phoneSetting and phoneSettingWrite. */
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
  'ownerModerates',
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
] as const satisfies readonly RendererCoreMethod[];

/** Discord calls the phone may make: posting from the Archive composer and its pickers, and its Chat settings while they sync. */
export const PHONE_DISCORD_METHODS = ['send', 'uploadLimit', 'prepareUploads', 'uploadChunk', 'finishUpload', 'edit', 'deleteMessage', 'forward', 'react', 'gifs', 'expressions', 'commands', 'runCommand', 'autocomplete', 'useComponent', 'submitModal', 'roles', 'requestMembers', 'createThread', 'sendDirect', 'profile', 'mutualFriends', 'reactors', 'setChatSettings'] as const satisfies readonly (keyof RendererApi['discord'])[];
export type PhoneDiscordMethod = (typeof PHONE_DISCORD_METHODS)[number];

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
] as const satisfies readonly AppEvent['type'][];
const coreMethods = new Set<string>(PHONE_CORE_METHODS);
const eventTypes = new Set<string>(PHONE_EVENT_TYPES);

/** Limits phone settings to declared host/plugin subsets. Undeclared settings appear unset, preserving phone defaults. */
export const PHONE_HOST_SETTINGS: Readonly<Record<string, PhoneSettingView>> = {
  [SETTINGS_KEYS.appearance]: true,
  [SETTINGS_KEYS.privacyMode]: true,
  [SETTINGS_KEYS.savedSearches]: true,
  [SETTINGS_KEYS.searchSort]: true,
  [SETTINGS_KEYS.discordSidebar]: true,
  [SETTINGS_KEYS.archiveDensity]: true,
  // The count policy changes the directory and opening banner; its event reaches open phone views too.
  [SETTINGS_KEYS.countedBots]: true,
  // Each provider's switch and model, and the Jev switches; not the Ollama address or how Jev connects.
  [SETTINGS_KEYS.ai]: ['providers', 'jev'],
  // Sync status shows how far back a new channel is filled in.
  [SETTINGS_KEYS.archive]: ['backfillDays'],
  // Which panels are placed and folded decides whether a panel shows its body, on the phone as on the desktop.
  [SETTINGS_KEYS.layoutPreset]: true,
  [SETTINGS_KEYS.layoutCustom]: true,
  [SETTINGS_KEYS.layoutCollapsedPanels]: true,
  [SETTINGS_KEYS.layoutSidebarCollapsed]: true,
  // The account's chat settings, which a phone syncing shows.
  [SETTINGS_KEYS.discordChat]: true,
};

export { PHONE_DEVICE_SETTINGS, isPhoneDeviceSetting } from './phoneDevice';

/** Settings the phone may write, each with the normalizer its value is stored through. Others stay desktop-only. */
export const PHONE_WRITABLE_SETTINGS: Readonly<Record<string, (value: unknown) => unknown>> = {
  [SETTINGS_KEYS.countedBots]: normalizeCountedBots,
};

/** Whether the phone may write setting `key` (PHONE_WRITABLE_SETTINGS). */
export const phoneMayWriteSetting = (key: string): boolean => Object.hasOwn(PHONE_WRITABLE_SETTINGS, key);

/** `value` as stored for the phone's write of setting `key`; undefined when the phone may not write it. */
export function phoneSettingWrite(key: string, value: unknown): { value: unknown } | undefined {
  return phoneMayWriteSetting(key) ? { value: PHONE_WRITABLE_SETTINGS[key]!(value) } : undefined;
}

/** How much of setting `key` the phone reads; undefined when it reads none. */
const phoneSettingView = (key: string): PhoneSettingView | undefined =>
  Object.hasOwn(PHONE_HOST_SETTINGS, key) ? PHONE_HOST_SETTINGS[key] : pluginPhoneSetting(key);

/** The fields of `value` at `paths` (dot paths), nested as they were; undefined when `value` isn't an object. */
function pick(value: unknown, paths: readonly string[]): unknown {
  if (!isObj(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const steps = path.split('.');
    let from: unknown = value;
    for (const step of steps) from = isObj(from) ? from[step] : undefined;
    if (from === undefined) continue;
    let to = out;
    for (const step of steps.slice(0, -1)) to = (to[step] ??= {}) as Record<string, unknown>;
    to[steps.at(-1)!] = from;
  }
  return out;
}

const project = (value: unknown, view: PhoneSettingView): unknown => (view === true ? value : pick(value, view));

/** What the phone reads of setting `key` holding `value`: the part it may read, or undefined (unset). */
export function phoneSetting(key: string, value: unknown): unknown {
  const view = phoneSettingView(key);
  return view === undefined ? undefined : project(value, view);
}

/** Filters phone host/plugin events by type/audience and trims settings changes to allowed subsets. Unavailable events return null. */
export function phoneAppEvent(e: AppEvent): AppEvent | null {
  if (e.type === 'plugin-event') return phoneGetsEvent(e.pluginId, e.name) ? e : null;
  if (!eventTypes.has(e.type)) return null;
  if (e.type !== 'setting-changed') return e;
  const view = phoneSettingView(e.key);
  return view === undefined ? null : { ...e, value: project(e.value, view) };
}

/** A core call the phone may make (PHONE_CORE_METHODS). Plugin calls go through the 'plugins' group, stamped 'phone'. */
export const phoneMayCallCore = (method: string): boolean => coreMethods.has(method);

/** Whether an event reaches the phone (phoneAppEvent). */
export const phoneGetsAppEvent = (e: AppEvent): boolean => phoneAppEvent(e) !== null;

/** Whether the phone may make this plugin core call (its declared audiences). */
export { phoneMayCall as phoneMayCallPlugin };

/** A call as the phone sends it: `core` methods, a plugin's `callCore`, or a Discord method. */
export type PhoneCallGroup = 'core' | 'discord' | 'plugins';
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
