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
