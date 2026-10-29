// What an emoji's popout says, in Discord's words (its web client's strings, read 2026-10-28).
import type { EmojiSource, EmojiSourceGuild } from '@shared/emoji';

/** Where an emoji stands for the owner, seen from a channel: its server, another of theirs, one to join, or none named. */
export type EmojiOrigin = 'here' | 'yours' | 'joinable' | 'unknown';

/** `guildId`: the channel's server (none: a DM or no channel). */
export function emojiOrigin(source: EmojiSource, guildId: string | undefined): EmojiOrigin {
  if (!source.guild) return 'unknown';
  if (!source.joined) return 'joinable';
  return source.guild.id === guildId ? 'here' : 'yours';
}

/** `everywhere`: the owner's plan lets them use emoji in every server (Nitro). */
export function emojiBlurb(origin: EmojiOrigin, everywhere: boolean): string {
  switch (origin) {
    case 'here':
      return everywhere ? 'This emoji is from this server. You can use it everywhere.' : 'This emoji is from this server. Get Nitro to use it everywhere.';
    case 'yours':
      return everywhere ? 'This emoji is from one of your servers. Type its name in the chat bar to use it.' : 'This emoji is from one of your servers. Get Nitro to use it everywhere.';
    case 'joinable':
      return everywhere ? 'Want to use this emoji everywhere? Join the server.' : 'Want to use this emoji everywhere? Get Nitro and join the server.';
    case 'unknown':
      return 'This emoji is from a server that is either invite-only or unavailable.';
  }
}

/** The line under the server's name. */
export const serverKind = (g: EmojiSourceGuild): string => (g.discoverable ? 'Discoverable Server' : 'Invite-only server');
