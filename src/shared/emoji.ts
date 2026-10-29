import { mediaUrl } from './media';

/** Discord custom emoji markup in message text: <:name:id> or <a:name:id> (animated). */
export const CUSTOM_EMOJI = /<(a?):(\w{2,32}):(\d{15,21})>/g;

export interface CustomEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/** A custom emoji with the server it belongs to. */
export interface GuildEmoji extends CustomEmoji {
  guildId: string;
}

export const emojiExt = (animated: boolean): 'gif' | 'webp' => (animated ? 'gif' : 'webp');

export const emojiUrl = (e: Pick<CustomEmoji, 'id' | 'animated'>): string => mediaUrl('emoji', `${e.id}.${emojiExt(e.animated)}`);

export type ContentSegment = { kind: 'text'; text: string } | { kind: 'emoji'; emoji: CustomEmoji };

/** Splits message text into plain text and custom-emoji segments for rendering. */
export function segmentContent(content: string): ContentSegment[] {
  const out: ContentSegment[] = [];
  let last = 0;
  for (const m of content.matchAll(CUSTOM_EMOJI)) {
    if (m.index > last) out.push({ kind: 'text', text: content.slice(last, m.index) });
    out.push({ kind: 'emoji', emoji: { animated: m[1] === 'a', name: m[2]!, id: m[3]! } });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last) });
  return out;
}

/** An emoji as Discord's favorites list names it: a custom emoji's id, or a Unicode emoji's names (Discord's first). */
export type FavoriteEmoji = { id: string } | { names: string[] };

/** Adds (`favorite`) or removes an emoji from the owner's Discord favorites. */
export interface EmojiFavoriteChange {
  emoji: FavoriteEmoji;
  favorite: boolean;
}

/** A stored key without the colons Discord may keep around a Unicode name (":fire:"). */
const bareKey = (key: string): string => key.replace(/^:|:$/g, '');
const keysOf = (emoji: FavoriteEmoji): string[] => ('id' in emoji ? [emoji.id] : emoji.names);

export const isFavoriteEmoji = (favorites: readonly string[], emoji: FavoriteEmoji): boolean => {
  const keys = new Set(keysOf(emoji));
  return favorites.some((k) => keys.has(bareKey(k)));
};

/** `favorites` with `emoji` appended (as Discord adds) or every spelling of it removed; others keep their order. */
export function withFavoriteEmoji(favorites: readonly string[], emoji: FavoriteEmoji, favorite: boolean): string[] {
  const keys = new Set(keysOf(emoji));
  const others = favorites.filter((k) => !keys.has(bareKey(k)));
  if (!favorite) return others;
  if (others.length < favorites.length) return [...favorites];
  const key = keysOf(emoji)[0];
  return key ? [...favorites, key] : [...favorites];
}

/** A custom emoji's server as its popout names it. */
export interface EmojiSourceGuild {
  id: string;
  name: string;
  icon: string | null;
  /** Listed in Server Discovery (Discord's DISCOVERABLE feature); else invite-only. */
  discoverable: boolean;
}

/** Where a custom emoji comes from. `guild` null: Discord names no server (invite-only or unavailable). */
export interface EmojiSource {
  guild: EmojiSourceGuild | null;
  /** The owner is in that server. */
  joined: boolean;
}
