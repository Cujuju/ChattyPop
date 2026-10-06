// The DM list's rules (docs/dms.md §3.3, §4.1), DOM-free so tests import them; state/dms.ts applies them to the directory.
import type { DirectoryChannel } from '@shared/contract';
import { DM_CHANNEL_TYPE, GROUP_DM_CHANNEL_TYPE, compareSnowflakes } from '@shared/discord';

/** A DM or group DM with its `dm` block. */
export type DmChannel = DirectoryChannel & { dm: NonNullable<DirectoryChannel['dm']> };
/** The DM list's filters, first the default. */
export const DM_FILTERS = ['all', 'unread', 'groups'] as const;
export type DmFilter = (typeof DM_FILTERS)[number];

export const isDmChannel = (c: DirectoryChannel): c is DmChannel => c.dm !== undefined;

/** DM unread combines newer-than-ack messages and positive Discord counts. Counts cover unknown acks; muted DMs rely on ack state. */
export const isUnread = (c: DmChannel): boolean =>
  c.mentionCount > 0 || (c.dm.lastMessageId !== null && c.dm.ackId !== null && compareSnowflakes(c.dm.lastMessageId, c.dm.ackId) > 0);

/** Muted on Discord at `now`; a mute that has ended needs no event. */
export const isMuted = (c: DmChannel, now: number): boolean => c.dm.muteEndsMs !== null && c.dm.muteEndsMs > now;

export const isGroup = (c: DmChannel): boolean => c.kind === GROUP_DM_CHANNEL_TYPE;

/** A group the owner left or was removed from: read-only, no composer. A closed one-to-one DM reopens on a message. */
export const isClosedGroup = (c: DirectoryChannel): boolean => c.kind === GROUP_DM_CHANNEL_TYPE && c.dm?.closed === true;

/**
 * A message request (read-only until accepted in Discord) or a group left: neither can be archived, nor take a message.
 * Main and core refuse both as well.
 */
export const isReadOnlyDm = (c: DirectoryChannel): boolean => isClosedGroup(c) || c.dm?.request === true;

/** An open one-to-one DM that is no request: the client opens it with no request, and New message offers its person. */
export const isOpenOneToOne = (c: DmChannel): boolean => c.kind === DM_CHANNEL_TYPE && !c.dm.closed && !c.dm.request;

/** `query` (any case, trimmed) is in the DM's name or a member's name; a blank query matches every DM. */
export function matchesSearch(c: DmChannel, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || [c.name, ...c.dm.recipients.map((r) => r.name)].some((n) => n.toLocaleLowerCase().includes(q));
}

const FILTERS: Record<DmFilter, (c: DmChannel) => boolean> = { all: () => true, unread: isUnread, groups: isGroup };

export interface DmSections {
  /** Open conversations, Discord's order. */
  list: DmChannel[];
  /** Message requests and spam: listed read-only, folded. */
  requests: DmChannel[];
  /** Closed DMs and groups left: kept with their history, folded. */
  closed: DmChannel[];
}

/** `dms` (in Discord's order) searched and filtered, then split: closed first wins over request. */
export function dmSections(dms: readonly DmChannel[], query: string, filter: DmFilter): DmSections {
  const out: DmSections = { list: [], requests: [], closed: [] };
  for (const c of dms) {
    if (!matchesSearch(c, query) || !FILTERS[filter](c)) continue;
    (c.dm.closed ? out.closed : c.dm.request ? out.requests : out.list).push(c);
  }
  return out;
}

/** The DMs segment's count, as Discord's badge counts: open, unread, unmuted conversations, requests excluded. */
export const unreadDmCount = (dms: readonly DmChannel[], now: number): number =>
  dms.filter((c) => !c.dm.closed && !c.dm.request && isUnread(c) && !isMuted(c, now)).length;
