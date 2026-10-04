// The owner's reactions: joining in on (or taking back) a message's reaction, and the picker that adds a new one.
import { api } from '@/api';
import { createResource, createSignal, untrack } from 'solid-js';
import type { UsedEmoji } from '@shared/compose';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import { errorText } from '@/ui/format';
import { refreshLoaded } from './archive';
import { onAppEvent } from './events';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { oneOf } from '@shared/normalize';

/** The reaction picker's emoji sets: the account's server emoji, or Unicode. */
const REACTION_TABS = ['emoji', 'system'] as const;
export type ReactionTab = (typeof REACTION_TABS)[number];
/** The set the reaction picker last showed, restored on start. */
export const [reactionTab, setReactionTab] = createSetting<ReactionTab>(SETTINGS_KEYS.reactionTab, REACTION_TABS[0], (v) => oneOf(REACTION_TABS, v, REACTION_TABS[0]));

/** A picked or often-used emoji as a reaction (id null: Unicode, its text the name). */
export const asReaction = (e: UsedEmoji): ArchiveEmoji => ('unicode' in e ? { id: null, name: e.unicode, animated: false } : { id: e.custom.id, name: e.custom.name, animated: e.custom.animated });

/** The owner's most-used reactions fetched: enough to fill a quick-reaction row after dropping ones unusable in a channel. */
const OWN_REACTIONS_MAX = 24;
/** Fetched once first wanted (wantOwnReactions), then again after each reaction the owner adds. */
const [ownReactionsWanted, setOwnReactionsWanted] = createSignal(0);
export const [ownReactions] = createResource(
  () => ownReactionsWanted() || null,
  () => api.core.ownReactions(OWN_REACTIONS_MAX),
);
export const wantOwnReactions = (): void => {
  if (!untrack(ownReactionsWanted)) setOwnReactionsWanted(1);
};
const refreshOwnReactions = (): void => {
  const n = untrack(ownReactionsWanted);
  if (n) setOwnReactionsWanted(n + 1);
};
// Counted over visible messages only: a server hidden since must not keep its emoji in the ranking.
onAppEvent('privacy-changed', refreshOwnReactions);

/** Whether `m` carries the owner's reaction with `emoji`. */
export const reactedWith = (m: ArchiveMessage, emoji: ArchiveEmoji): boolean =>
  m.reactions.some((r) => r.me && (emoji.id ? r.emoji.id === emoji.id : !r.emoji.id && r.emoji.name === emoji.name));

/** Discord takes no reactions on a deleted message. */
export const canReact = (m: ArchiveMessage): boolean => m.deletedAt === null;

/**
 * Adds or takes back the owner's reaction. Main has the archive take it before the call resolves, so the refresh shows it.
 * A failure shows as an alert: a chip or picker holds no error line.
 */
export function react(m: ArchiveMessage, emoji: ArchiveEmoji, add: boolean): void {
  api.discord
    .react({ channelId: m.channelId, messageId: m.id, emoji, add })
    .then(() => {
      if (add) refreshOwnReactions();
      return refreshLoaded([m.id]);
    })
    .catch((err: unknown) => window.alert(`Couldn't ${add ? 'add' : 'remove'} the reaction: ${errorText(err)}`));
}

/** The reaction picker: which message, opened at this point (the pointer, or the long press). */
export interface ReactionPickerState {
  message: ArchiveMessage;
  x: number;
  y: number;
}
export const [reactionPicker, setReactionPicker] = createSignal<ReactionPickerState | null>(null);
export const openReactionPicker = (message: ArchiveMessage, x: number, y: number): void => void setReactionPicker({ message, x, y });
export const closeReactionPicker = (): void => void setReactionPicker(null);
