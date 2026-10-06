// Parses Discord inline tokens and plain-text equivalents for notifications/search. Drawable views use InlineMarkdown.
import { MS_PER_S } from './units';

/** Parses custom emoji, user/role/channel mentions and timestamps. Capture groups identify emoji names, users, channels and Unix seconds; roles have none. */
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

/** Moves snippet cuts to token starts or, with past, token ends, preserving whole renderable tokens. */
export function cutOutsideTokens(text: string, i: number, past: boolean): number {
  for (const m of text.matchAll(DISCORD_TOKEN)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= i) break;
    if (i < end) return past ? end : start;
  }
  return i;
}
