// Person profiles, directory people and archive footprint types.
import type { AuthorStyle } from './archive';
import type { NameEffect } from '../nameFonts';

/**
 * How a person's name shows in a place (personNames), as Discord draws it there. In a server: their nickname, the
 * colour or Enhanced Role Style of their highest coloured role, and their Nitro font. Outside one: their display name and
 * their whole Nitro style (font, colours, effect).
 */
export interface PersonName {
  id: string;
  name: string;
  /** 0xRRGGBB; null for the default name colour. */
  color: number | null;
  /** A gradient's stops (role gradient or holographic style, Nitro's Gradient effect); null for a flat colour. */
  gradient: number[] | null;
  font: AuthorStyle['font'];
  /** Their Nitro name effect outside a server, which the theme draws (data-name-effect); null in one or for none. */
  effect: NameEffect | null;
  /** The place the name was read for; null for none, or one privacy mode hides. Their profile opens there. */
  channelId: string | null;
}
/** A person found by name, for pickers (a rule's Who): their display name, else username. */
export interface PersonMatch {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
}

/**
 * Something the composer's `@` offers: a person, a server's mentionable role (`color` 0xRRGGBB, null for none), or
 * Discord's @everyone / @here, sent as typed.
 */
export type MentionCandidate = (PersonMatch & { kind: 'user'; /** Every name they match by: username, nickname, display name. */ names: string[] }) | { kind: 'role'; id: string; name: string; color: number | null } | { kind: 'everyone' } | { kind: 'here' };

/** One person across the archive (visible channels only while privacy mode is on). */
export interface PersonProfile {
  id: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  /** What Discord draws with their name anywhere: Nitro font, avatar decoration, server tag. */
  style: Pick<AuthorStyle, 'font' | 'decoration' | 'tag'>;
  /**
   * Server nicknames, per server they have one in. `channelId`: a visible channel of that server, the place their name
   * is read for there (personNames: role colour, font); null when the archive holds none.
   */
  nicknames: { guildId: string; guildName: string | null; nick: string; channelId: string | null }[];
  totals: { messages: number; edited: number; deleted: number; links: number; attachments: number };
  /** Their first and last archived message; null when none are visible. */
  firstTs: number | null;
  lastTs: number | null;
  /** Where they post most, busiest first (PERSON_TOP_CHANNELS). The server is null for a place outside one (a DM). */
  channels: { channelId: string; channelName: string; guildId: string | null; guildName: string | null; guildIcon: string | null; count: number; lastTs: number }[];
  /** Links they shared, at their latest share, newest first (PERSON_RECENT_LINKS). */
  links: { url: string; platform: string; title: string | null; messageId: string; channelId: string; ts: number }[];
}
