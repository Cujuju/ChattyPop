// What the phone may reach, whatever transport carries it (docs/plugin-architecture.md §3, phone points).
import { phoneGetsEvent, phoneMayCall, pluginPhoneSetting } from './bundledPlugins';
import type { PhoneSettingView } from './bundledTypes';
import { isObj } from './normalize';
import type { RendererApi, RendererCoreMethod } from './rendererApi';
import { SETTINGS_KEYS } from './settings';
import type { AppEvent } from './types/ipc';

/**
 * Core methods the phone may call: archive reads, plus the writes the owner asked for
 * (archive search). Feature calls use declared plugin audiences; keys and rules stay desktop-only, and `getSetting`
 * answers only what phoneSetting allows.
 */
export const PHONE_CORE_METHODS = [
  'status',
  'getSetting',
  'directory',
  'markChannelViewed',
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
] as const satisfies readonly RendererCoreMethod[];

/** Discord calls the phone may make: posting from the Archive composer and its pickers. */
export const PHONE_DISCORD_METHODS = ['send', 'edit', 'deleteMessage', 'forward', 'react', 'gifs', 'expressions', 'commands', 'runCommand', 'autocomplete', 'useComponent', 'submitModal', 'roles', 'requestMembers', 'createThread', 'sendDirect', 'profile', 'mutualFriends', 'reactors'] as const satisfies readonly (keyof RendererApi['discord'])[];
export type PhoneDiscordMethod = (typeof PHONE_DISCORD_METHODS)[number];

/** Events the phone's stores use. Main's own work orders (plugins' posts and replies, audio fetches) never leave the PC. */
export const PHONE_EVENT_TYPES = [
  'archive-changed',
  'sync-progress',
  'opt-in-changed',
  'dm-activity',
  'read-states-changed',
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

/**
 * Host settings the phone's stores read, and how much of each. Plugins declare theirs (each preference's `phone`);
 * the phone reads every other setting as unset, so its store keeps its default.
 */
export const PHONE_HOST_SETTINGS: Readonly<Record<string, PhoneSettingView>> = {
  [SETTINGS_KEYS.appearance]: true,
  [SETTINGS_KEYS.privacyMode]: true,
  [SETTINGS_KEYS.savedSearches]: true,
  [SETTINGS_KEYS.searchSort]: true,
  [SETTINGS_KEYS.discordSidebar]: true,
  [SETTINGS_KEYS.archiveDensity]: true,
  // Each provider's switch and model, and the Jev switches; not the Ollama address or how Jev connects.
  [SETTINGS_KEYS.ai]: ['providers', 'jev'],
  // Sync status shows how far back a new channel is filled in.
  [SETTINGS_KEYS.archive]: ['backfillDays'],
  // Which panels are placed and folded decides whether a panel shows its body, on the phone as on the desktop.
  [SETTINGS_KEYS.layoutPreset]: true,
  [SETTINGS_KEYS.layoutCustom]: true,
  [SETTINGS_KEYS.layoutCollapsedPanels]: true,
  [SETTINGS_KEYS.layoutSidebarCollapsed]: true,
};

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

/**
 * An event as the phone gets it: PHONE_EVENT_TYPES and plugin events whose audiences include the phone; a setting
 * change only for a setting it reads, cut to the part it reads. null when the phone gets none.
 */
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
