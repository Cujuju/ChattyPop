// Discord's inline tokens in message text, and the same text as plain words for places that can't draw them
// (desktop notifications, search hit lines). Views that can draw them use ui/Markdown's InlineMarkdown.
import { MS_PER_S } from './units';

/**
 * One inline token: custom emoji <a:name:id>, user <@id> / <@!id>, role <@&id>, channel <#id>, timestamp <t:unix:style>.
 * Groups: 1 emoji name, 2 user id, 3 channel id, 4 unix seconds (role has none).
 */
export const DISCORD_TOKEN = /<a?:(\w{2,32}):\d{15,21}>|<@!?(\d{15,21})>|<@&\d{15,21}>|<#(\d{15,21})>|<t:(-?\d{1,13})(?::[tTdDfFR])?>/g;

/** Names the plain text uses for mentions: users from the message's own mention list, channels from the caller. */
export interface MentionNames {
  users?: Readonly<Record<string, string>>;
  channel?: (id: string) => string | undefined;
}

/** `text` with each token as words: `:name:`, `@name`, `@role`, `#channel`, a local date and time. */
export function plainDiscordText(text: string, names: MentionNames = {}): string {
  return text.replace(DISCORD_TOKEN, (_all, emoji?: string, user?: string, channel?: string, unix?: string) => {
    if (emoji) return `:${emoji}:`;
    if (user) return `@${names.users?.[user] ?? 'unknown-user'}`;
    if (channel) return `#${names.channel?.(channel) ?? 'unknown-channel'}`;
    if (unix) return new Date(Number(unix) * MS_PER_S).toLocaleString();
    return '@role';
  });
}

/**
 * Moves a cut at `i` in `text` out of any token it falls inside: back to the token's start, or with `past` to its end.
 * A snippet cut there keeps whole tokens, so they still render.
 */
export function cutOutsideTokens(text: string, i: number, past: boolean): number {
  for (const m of text.matchAll(DISCORD_TOKEN)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= i) break;
    if (i < end) return past ? end : start;
  }
  return i;
}
