// The Archive composer's contract: a message the owner posts, GIF results, and the emoji and stickers they can pick.
import type { CustomEmoji, GuildEmoji } from './emoji';
import { escapeRegex } from './keywordPattern';
import type { ArchiveEmoji } from './types/archive';

/** A file attached in the composer. */
export interface OwnerFile {
  name: string;
  bytes: Uint8Array;
}

/** A message the owner posts from the Archive composer. */
export interface OwnerMessage {
  channelId: string;
  text: string;
  /** Makes it a Discord reply; `ping` is Discord's @ON (the replied-to author is notified). */
  replyTo: { messageId: string; ping: boolean } | null;
  files: OwnerFile[];
  /** A sticker sent with it; Discord's picker sends one at a time. */
  stickerId: string | null;
  /** A GIF picked in the GIF picker: `text` is its page URL, as the live client sends it; `query` found it. */
  gif: { id: string; query: string } | null;
  /** Made once by the sender and kept across retries: Discord enforces it, so a retried send can't post twice. */
  nonce: string;
}

/** One of the owner's messages, to edit or delete. */
export interface OwnerMessageRef {
  channelId: string;
  messageId: string;
}

/** The owner forwarding one message (Discord's Forward) to another channel; a note goes after it as its own message. */
export interface OwnerForward {
  /** The message forwarded; guildId is null for a DM. */
  source: OwnerMessageRef & { guildId: string | null };
  /** Where it goes. */
  channelId: string;
  /** Made once per destination by the sender, so a retry can't post it twice. */
  nonce: string;
}

/** The owner adding (or taking back) their reaction on a message; `emoji.id` is null for a Unicode emoji. */
export interface OwnerReaction extends OwnerMessageRef {
  emoji: ArchiveEmoji;
  add: boolean;
}

/**
 * An edit of one of the owner's messages: new text (Discord's Edit), the attachments it keeps (an attachment's Modify and
 * Delete), or both. What it leaves out stays as it is.
 */
export interface OwnerEdit extends OwnerMessageRef {
  text?: string;
  /** Every attachment the message keeps, as it should be; one left out is removed from the message. */
  attachments?: KeptAttachment[];
}

/** An attachment a message keeps, as Discord's client names it: the id alone, or with Modify's new alt text and spoiler mark. */
export interface KeptAttachment {
  id: string;
  change?: { description: string; spoiler: boolean };
}

/** Discord's longest attachment description (alt text). */
export const ALT_TEXT_MAX = 1024;

/** A GIF result from Discord's GIF search (Klipy behind it). */
export interface Gif {
  id: string;
  /** Page URL: sent as the message text, which Discord unfurls. */
  url: string;
  /** Preview video. */
  src: string;
  width: number;
  height: number;
}

/** Discord's sticker format_type. */
export const STICKER_FORMAT = { png: 1, apng: 2, lottie: 3, gif: 4 } as const;

export interface Sticker {
  id: string;
  name: string;
  formatType: number;
  /** Words Discord lists for search (its `tags`). */
  tags: string;
}

/** A server's own sticker. */
export interface GuildSticker extends Sticker {
  guildId: string;
}

/** One of Discord's standard sticker packs. */
export interface StickerPack {
  id: string;
  name: string;
  stickers: Sticker[];
}

/** What Discord's plans unlock for picking, per the live client's perk table. */
export interface PlanPerks {
  animatedEmoji: boolean;
  emojiEverywhere: boolean;
  stickersEverywhere: boolean;
}

/** Discord's premium_type: 1 Nitro Classic, 2 Nitro, 3 Nitro Basic. */
const PREMIUM_CLASSIC = 1;
const PREMIUM_NITRO = 2;
const PREMIUM_BASIC = 3;

/** Classic and Basic unlock emoji everywhere and animated emoji; stickers everywhere is Nitro and Basic only. */
export function planPerks(premiumType: number): PlanPerks {
  const emoji = premiumType === PREMIUM_CLASSIC || premiumType === PREMIUM_NITRO || premiumType === PREMIUM_BASIC;
  return { animatedEmoji: emoji, emojiEverywhere: emoji, stickersEverywhere: premiumType === PREMIUM_NITRO || premiumType === PREMIUM_BASIC };
}

/** An emoji the owner has used: Unicode text, or a custom emoji. */
export type UsedEmoji = { unicode: string } | { custom: CustomEmoji };

/** Everything the composer's pickers offer, with what the account's plan allows. */
export interface ExpressionCatalog {
  emojis: GuildEmoji[];
  stickers: GuildSticker[];
  packs: StickerPack[];
  perks: PlanPerks;
}

/** Whether a custom emoji can be sent in a channel of `guildId` (DM_GUILD_ID for DMs), as Discord's picker decides. */
export const canUseEmoji = (e: GuildEmoji, guildId: string, perks: PlanPerks): boolean =>
  (!e.animated || perks.animatedEmoji) && (e.guildId === guildId || perks.emojiEverywhere);

/** Standard-pack stickers (no server) go anywhere; a server's own only in that server unless the plan allows. */
export const canUseSticker = (s: Sticker & { guildId?: string }, guildId: string, perks: PlanPerks): boolean =>
  s.guildId === undefined || s.guildId === guildId || perks.stickersEverywhere;

/**
 * A token for `name` free in `picked` (taken by another, or `reserved`, it gets Discord's `~N` suffix); records `value`
 * under it.
 */
function claimToken<T extends { id: string }>(name: string, value: T, picked: Map<string, T>, reserved: ReadonlySet<string> = new Set()): string {
  for (let n = 0; ; n++) {
    const token = n === 0 ? name : `${name}~${n}`;
    if (reserved.has(token)) continue;
    const taken = picked.get(token);
    if (!taken || taken.id === value.id) {
      picked.set(token, value);
      return token;
    }
  }
}

/** The `:token:` a picked custom emoji shows as in the composer text; records the pick in `picked`. */
export const emojiToken = (e: CustomEmoji, picked: Map<string, CustomEmoji>): string => `:${claimToken(e.name, e, picked)}:`;

/** A person or role picked from the composer's `@` suggestions; `kind` is absent in drafts saved before roles (a person). */
export interface MentionPick {
  id: string;
  kind?: 'user' | 'role';
}

/** Text Discord itself pings by: a role so named takes a `~N` token, or sending would ping the role instead. */
const GROUP_MENTION_WORDS: ReadonlySet<string> = new Set(['everyone', 'here']);

/** The `@token` a picked person (their username, as Discord's composer shows it) or role (its name) shows as in the text. */
export const mentionToken = (name: string, p: Required<MentionPick>, picked: Map<string, MentionPick>): string =>
  `@${claimToken(name, { id: p.id, kind: p.kind }, picked, GROUP_MENTION_WORDS)}`;

/** Discord's markup for a picked mention. */
const mentionMarkup = (p: MentionPick): string => (p.kind === 'role' ? `<@&${p.id}>` : `<@${p.id}>`);

/** Replaces picked `@token`s with Discord's mention markup; the longest token wins, and one inside a longer name stays. */
export function expandMentionTokens(text: string, picked: Map<string, MentionPick>): string {
  const tokens = [...picked.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  if (!tokens.length) return text;
  // Not after a word (an email address); not followed by more of a name (`@bob` in `@bobby`, `@bob.smith`, `@bob~1`).
  // A name character is a letter, digit or mark of any script.
  const name = '[\\p{L}\\p{N}\\p{M}_]';
  return text.replace(new RegExp(`(?<!${name}|@)@(${tokens.join('|')})(?!${name}|~|\\.${name})`, 'gu'), (_, token: string) => mentionMarkup(picked.get(token)!));
}

/** Replaces picked `:token:`s with Discord's custom emoji markup; other text stays as typed. */
export const expandEmojiTokens = (text: string, picked: Map<string, CustomEmoji>): string =>
  text.replace(/:([\w~]+):/g, (whole, token: string) => {
    const e = picked.get(token);
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : whole;
  });

/** The shrug, escaped so Discord's markdown shows its backslash and underscores as typed. */
const SHRUG = '¯\\\\_(ツ)\\_/¯';
const TABLEFLIP = '(╯°□°)╯︵ ┻━┻';
const UNFLIP = '┬─┬ノ( º _ ºノ)';

/** A built-in that adds `face` after the message, or sends it alone. */
const appending =
  (face: string) =>
  (text: string): string | null =>
    text ? `${text} ${face}` : face;

/**
 * Discord's built-in commands: typed as `/name text` and turned into plain text before sending, as the client does
 * (Discord itself only ever gets a message). `apply` returns null when the command needs text it wasn't given.
 * `messageOptional`: whether the text after it may be left out (the menu shows it as an optional option).
 */
export const BUILTIN_COMMANDS = [
  { name: 'shrug', description: 'Appends ¯\\_(ツ)_/¯ to your message.', messageOptional: true, apply: appending(SHRUG) },
  { name: 'tableflip', description: 'Appends (╯°□°)╯︵ ┻━┻ to your message.', messageOptional: true, apply: appending(TABLEFLIP) },
  { name: 'unflip', description: 'Appends ┬─┬ノ( º _ ºノ) to your message.', messageOptional: true, apply: appending(UNFLIP) },
  { name: 'me', description: 'Displays text with emphasis.', messageOptional: false, apply: (text: string): string | null => (text ? `_${text}_` : null) },
  { name: 'spoiler', description: 'Marks your message as a spoiler.', messageOptional: false, apply: (text: string): string | null => (text ? `||${text}||` : null) },
] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

/** A built-in typed at the start of the text, with what follows it; null when the text doesn't start with one. */
export function typedBuiltin(text: string): { command: BuiltinCommand; rest: string } | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = m && BUILTIN_COMMANDS.find((b) => b.name === m[1]!.toLowerCase());
  return command ? { command, rest: (m[2] ?? '').trim() } : null;
}

/** The text to send: a built-in command applied, else the text as typed. Throws when a built-in lacks the text it needs. */
export function applyBuiltinCommand(text: string): string {
  const b = typedBuiltin(text);
  if (!b) return text;
  const out = b.command.apply(b.rest);
  if (out === null) throw new Error(`Type a message after /${b.command.name}.`);
  return out;
}
