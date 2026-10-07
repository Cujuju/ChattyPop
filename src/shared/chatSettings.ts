// Discord's Chat settings (its mobile Settings → Chat): the account's, synced through Discord's settings proto, and each
// device's own. Types, defaults and normalizers; state/chatSettings.ts keeps and syncs them.
import type { ArchiveEmoji } from './types/archive';
import { isObj } from './normalize';
import { isReactionEmoji } from './discord';

/** When spoilers show uncovered: on click, always, or always on servers the owner moderates. */
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
  /** Changes made in ChattyPop are written back to the account, so Discord's other clients follow them. */
  syncAcrossClients: boolean;
}

/** Discord's defaults for a new account. */
export const DEFAULT_DISCORD_CHAT_SETTINGS: DiscordChatSettings = {
  inlineLinkMedia: true,
  inlineAttachmentMedia: true,
  imageDescriptions: false,
  renderEmbeds: true,
  renderReactions: true,
  convertEmoticons: true,
  stickersInAutocomplete: true,
  spoilers: 'click',
  syncAcrossClients: true,
};

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

const oneOf = <T extends string>(options: readonly T[], v: unknown, fallback: T): T => ((options as readonly unknown[]).includes(v) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export function normalizeDiscordChatSettings(v: unknown): DiscordChatSettings {
  const o = isObj(v) ? v : {};
  const d = DEFAULT_DISCORD_CHAT_SETTINGS;
  return {
    inlineLinkMedia: bool(o['inlineLinkMedia'], d.inlineLinkMedia),
    inlineAttachmentMedia: bool(o['inlineAttachmentMedia'], d.inlineAttachmentMedia),
    imageDescriptions: bool(o['imageDescriptions'], d.imageDescriptions),
    renderEmbeds: bool(o['renderEmbeds'], d.renderEmbeds),
    renderReactions: bool(o['renderReactions'], d.renderReactions),
    convertEmoticons: bool(o['convertEmoticons'], d.convertEmoticons),
    stickersInAutocomplete: bool(o['stickersInAutocomplete'], d.stickersInAutocomplete),
    spoilers: oneOf(SPOILER_MODES, o['spoilers'], d.spoilers),
    syncAcrossClients: bool(o['syncAcrossClients'], d.syncAcrossClients),
  };
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
