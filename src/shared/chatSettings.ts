// Discord's Chat settings (its mobile Settings → Chat): the account's, synced through Discord's settings proto, and each
// device's own. Types, defaults and normalizers; state/chatSettings.ts keeps and syncs them.
import type { ArchiveEmoji } from './types/archive';
import { bool, isObj, oneOf } from './normalize';
import { isReactionEmoji } from './discord';

/** When spoilers show uncovered: on click, always, or always where the owner moderates (Manage Messages). */
export const SPOILER_MODES = ['click', 'always', 'moderated'] as const;
export type SpoilerMode = (typeof SPOILER_MODES)[number];

/** The account's chat settings, as Discord syncs them across its clients ("Sync across clients"). */
export interface DiscordChatSettings {
  /** Show images and videos posted as links. */
  inlineLinkMedia: boolean;
  /** Show images and videos uploaded to Discord; off shows file chips. */
  inlineAttachmentMedia: boolean;
  /** Show image descriptions (alt text). */
  imageDescriptions: boolean;
  /** Show embeds and link previews. */
  renderEmbeds: boolean;
  /** Show emoji reactions. */
  renderReactions: boolean;
  /** Turn typed emoticons such as :) into emoji. */
  convertEmoticons: boolean;
  /** Offer stickers among the composer's suggestions. */
  stickersInAutocomplete: boolean;
  spoilers: SpoilerMode;
  /** This device's choice (Discord stores none): its changes are written to the account, and the account's show here. */
  syncAcrossClients: boolean;
}

/** The settings Discord keeps in the account's settings proto. */
export type SyncedChatSettings = Omit<DiscordChatSettings, 'syncAcrossClients'>;
export const SYNCED_CHAT_SETTING_KEYS = [
  'inlineLinkMedia',
  'inlineAttachmentMedia',
  'imageDescriptions',
  'renderEmbeds',
  'renderReactions',
  'convertEmoticons',
  'stickersInAutocomplete',
  'spoilers',
] as const satisfies readonly (keyof SyncedChatSettings)[];
export type SyncedChatSettingKey = (typeof SYNCED_CHAT_SETTING_KEYS)[number];

/** What the account holds when its proto leaves a setting out. Verified 2026-10-06 for image descriptions, stickers and spoilers; the others are an assumption. */
export const DEFAULT_SYNCED_CHAT_SETTINGS: SyncedChatSettings = {
  inlineLinkMedia: true,
  inlineAttachmentMedia: true,
  imageDescriptions: false,
  renderEmbeds: true,
  renderReactions: true,
  convertEmoticons: true,
  stickersInAutocomplete: false,
  spoilers: 'click',
};

/** Discord's defaults for a new account, synced. */
export const DEFAULT_DISCORD_CHAT_SETTINGS: DiscordChatSettings = { ...DEFAULT_SYNCED_CHAT_SETTINGS, syncAcrossClients: true };

/** Video upload quality: the original, Discord's standard re-encode, or a smaller one. */
export const VIDEO_QUALITIES = ['best', 'standard', 'dataSaver'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/** What swiping a message right to left does. */
export const SWIPE_ACTIONS = ['reply', 'none'] as const;
export type SwipeAction = (typeof SWIPE_ACTIONS)[number];

/** Each device's own chat settings (never synced to Discord). */
export interface DeviceChatSettings {
  videoQuality: VideoQuality;
  /** Send images and videos at Data Saver quality while on a cellular network. */
  dataSaving: boolean;
  swipeAction: SwipeAction;
  doubleTapReact: boolean;
  doubleTapEmoji: ArchiveEmoji;
  /** Photos and videos taken with the in-app camera are saved to the device too. */
  saveCameraToDevice: boolean;
}

export const DEFAULT_DEVICE_CHAT_SETTINGS: DeviceChatSettings = {
  videoQuality: 'standard',
  dataSaving: false,
  swipeAction: 'reply',
  doubleTapReact: true,
  // Assumption: Discord's default double-tap reaction.
  doubleTapEmoji: { id: null, name: '❤️', animated: false },
  saveCameraToDevice: true,
};

export function normalizeSyncedChatSettings(v: unknown): SyncedChatSettings {
  const o = isObj(v) ? v : {};
  const d = DEFAULT_SYNCED_CHAT_SETTINGS;
  return {
    inlineLinkMedia: bool(o['inlineLinkMedia'], d.inlineLinkMedia),
    inlineAttachmentMedia: bool(o['inlineAttachmentMedia'], d.inlineAttachmentMedia),
    imageDescriptions: bool(o['imageDescriptions'], d.imageDescriptions),
    renderEmbeds: bool(o['renderEmbeds'], d.renderEmbeds),
    renderReactions: bool(o['renderReactions'], d.renderReactions),
    convertEmoticons: bool(o['convertEmoticons'], d.convertEmoticons),
    stickersInAutocomplete: bool(o['stickersInAutocomplete'], d.stickersInAutocomplete),
    spoilers: oneOf(SPOILER_MODES, o['spoilers'], d.spoilers),
  };
}

export function normalizeDiscordChatSettings(v: unknown): DiscordChatSettings {
  return { ...normalizeSyncedChatSettings(v), syncAcrossClients: bool(isObj(v) ? v['syncAcrossClients'] : undefined, DEFAULT_DISCORD_CHAT_SETTINGS.syncAcrossClients) };
}

/** A change to the account's settings: only its valid fields; empty when none is. */
export function normalizeSyncedChatChange(v: unknown): Partial<SyncedChatSettings> {
  if (!isObj(v)) return {};
  const full = normalizeSyncedChatSettings(v);
  const valid = (key: SyncedChatSettingKey): boolean => (key === 'spoilers' ? oneOf(SPOILER_MODES, v[key], null) !== null : typeof v[key] === 'boolean');
  return Object.fromEntries(SYNCED_CHAT_SETTING_KEYS.filter(valid).map((key) => [key, full[key]]));
}

export function normalizeDeviceChatSettings(v: unknown): DeviceChatSettings {
  const o = isObj(v) ? v : {};
  const d = DEFAULT_DEVICE_CHAT_SETTINGS;
  return {
    videoQuality: oneOf(VIDEO_QUALITIES, o['videoQuality'], d.videoQuality),
    dataSaving: bool(o['dataSaving'], d.dataSaving),
    swipeAction: oneOf(SWIPE_ACTIONS, o['swipeAction'], d.swipeAction),
    doubleTapReact: bool(o['doubleTapReact'], d.doubleTapReact),
    doubleTapEmoji: isReactionEmoji(o['doubleTapEmoji']) ? o['doubleTapEmoji'] : d.doubleTapEmoji,
    saveCameraToDevice: bool(o['saveCameraToDevice'], d.saveCameraToDevice),
  };
}

/** One device's chat choices as stored: the desktop's in SETTINGS_KEYS.chatDevice, each phone's by the phone transport. */
export interface DeviceChatRecord {
  device: DeviceChatSettings;
  /** DiscordChatSettings.syncAcrossClients. */
  syncAcrossClients: boolean;
  /** What the device shows while not syncing: the account's settings when sync turned off, then its own changes. */
  unsynced: SyncedChatSettings;
}

export const DEFAULT_DEVICE_CHAT_RECORD: DeviceChatRecord = {
  device: DEFAULT_DEVICE_CHAT_SETTINGS,
  syncAcrossClients: DEFAULT_DISCORD_CHAT_SETTINGS.syncAcrossClients,
  unsynced: DEFAULT_SYNCED_CHAT_SETTINGS,
};

export function normalizeDeviceChatRecord(v: unknown): DeviceChatRecord {
  const o = isObj(v) ? v : {};
  return {
    device: normalizeDeviceChatSettings(o['device']),
    syncAcrossClients: bool(o['syncAcrossClients'], DEFAULT_DEVICE_CHAT_RECORD.syncAcrossClients),
    unsynced: normalizeSyncedChatSettings(o['unsynced']),
  };
}

/** What a device shows: the account's settings while it syncs, else its own. */
export const shownChatSettings = (account: SyncedChatSettings, record: DeviceChatRecord): DiscordChatSettings => ({
  ...(record.syncAcrossClients ? account : record.unsynced),
  syncAcrossClients: record.syncAcrossClients,
});

/** The record with sync turned on or off. Off keeps showing what the account shows now; on shows the account's again. */
export const withSyncAcrossClients = (record: DeviceChatRecord, on: boolean, account: SyncedChatSettings): DeviceChatRecord => ({
  ...record,
  syncAcrossClients: on,
  unsynced: on ? record.unsynced : account,
});

/** Where a change to the shown Discord settings goes: the account while syncing, else the device's own copy. */
export type ChatChangeTarget = { account: Partial<SyncedChatSettings> } | { record: DeviceChatRecord };
export const routeChatChange = (record: DeviceChatRecord, change: Partial<SyncedChatSettings>): ChatChangeTarget =>
  record.syncAcrossClients ? { account: change } : { record: { ...record, unsynced: { ...record.unsynced, ...change } } };

/** Attachment views the inline-media and image-description settings cover (shared/media.ts attachmentView). */
const INLINE_UPLOAD_VIEWS = new Set(['image', 'video']);

/** Whether an upload of `view` shows inline; images and videos show as file chips while inline uploads are off. */
export const uploadShownInline = (view: string, s: SyncedChatSettings): boolean => !INLINE_UPLOAD_VIEWS.has(view) || s.inlineAttachmentMedia;

/** An image's description to show under it: only while image descriptions are on. */
export const shownImageDescription = (view: string, description: string | null, s: SyncedChatSettings): string | null =>
  s.imageDescriptions && view === 'image' && description ? description : null;

/** Whether a media-only embed's media stands in for the link that is a message's whole text (Discord then hides the text). */
export const embedMediaReplacesLink = (s: SyncedChatSettings): boolean => s.renderEmbeds && s.inlineLinkMedia;

/** Whether spoilers show uncovered in a channel where the owner `moderates` (has Manage Messages there). */
export const spoilersUncovered = (mode: SpoilerMode, moderates: boolean): boolean => mode === 'always' || (mode === 'moderated' && moderates);

/** Each choice as the Settings screens name it (Discord's mobile wording). */
export const SPOILER_MODE_LABELS: Readonly<Record<SpoilerMode, string>> = { click: 'On click', always: 'Always', moderated: 'On servers I moderate' };
export const VIDEO_QUALITY_LABELS: Readonly<Record<VideoQuality, string>> = { best: 'Best', standard: 'Standard (recommended)', dataSaver: 'Data Saver' };
export const SWIPE_ACTION_LABELS: Readonly<Record<SwipeAction, string>> = { reply: 'Reply', none: 'Nothing' };
