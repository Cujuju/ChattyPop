// The DM list from the embedded client's own gateway (docs/dms.md §3.1): READY's private channels, so listing every DM
// costs no request. Deltas (CHANNEL_*) reach core through ARCHIVED_GATEWAY_EVENTS.
import type { RawPrivateChannel, RawUser } from '@shared/discord';
import type { MainCore } from '../coreClient';
import type { GatewayTap } from './gatewayTap';
import { entriesOf } from './readyLists';

/** A private channel as READY may send it: full `recipients`, or `recipient_ids` naming users in READY's `users`. */
export type GatewayPrivateChannel = RawPrivateChannel & { recipient_ids?: string[] };

/** One account's DM list; `partial`: READY sent only some of it, so none may be closed. */
export interface PrivateChannelList {
  /** READY's user: the account signed in now. */
  self: RawUser;
  channels: RawPrivateChannel[];
  partial: boolean;
}

/** The fields core merges; anything else in the payload stays in main. */
function pick(c: GatewayPrivateChannel, recipients: RawUser[] | undefined): RawPrivateChannel {
  const { id, type, name, icon, last_message_id, owner_id, is_message_request, is_spam } = c;
  const known = { name, icon, recipients, last_message_id, owner_id, is_message_request, is_spam };
  // Absent stays absent: core keeps the stored value for a field the payload didn't carry.
  return { id, type, ...Object.fromEntries(Object.entries(known).filter(([, v]) => v !== undefined)) };
}

/**
 * `c` with its recipients as users. An id READY's users don't name leaves the roster unknown (core keeps the stored
 * one) rather than short.
 */
export function normalizePrivateChannel(c: GatewayPrivateChannel, users: ReadonlyMap<string, RawUser>): RawPrivateChannel {
  if (c.recipients !== undefined || c.recipient_ids === undefined) return pick(c, c.recipients);
  const resolved = c.recipient_ids.map((id) => users.get(id));
  return pick(c, resolved.every((u) => u !== undefined) ? (resolved as RawUser[]) : undefined);
}

/** READY's DM list for its user; null when READY names no user. */
export function readyPrivateChannels(d: Record<string, unknown>): PrivateChannelList | null {
  const self = d['user'] as RawUser | undefined;
  if (!self?.id) return null;
  const users = new Map(((d['users'] as RawUser[] | undefined) ?? []).map((u) => [u.id, u]));
  const { entries, partial } = entriesOf<GatewayPrivateChannel>(d['private_channels']);
  return { self, channels: entries.map((c) => normalizePrivateChannel(c, users)), partial };
}

/**
 * The shape of READY's private channels, for checking docs/dms.md §3.2's assumption (request and spam flags): field
 * names and counts only, never names, ids or content.
 */
export function privateChannelsShape(d: Record<string, unknown>): Record<string, unknown> {
  const raw = d['private_channels'];
  const { entries, partial } = entriesOf<GatewayPrivateChannel>(raw);
  const users = new Set(((d['users'] as { id: string }[] | undefined) ?? []).map((u) => u.id));
  const count = (has: (c: GatewayPrivateChannel) => boolean): number => entries.filter(has).length;
  return {
    list: Array.isArray(raw) ? 'array' : raw === undefined ? 'absent' : 'versioned',
    partial,
    channels: entries.length,
    fields: [...new Set(entries.flatMap((c) => Object.keys(c)))].sort(),
    withRecipients: count((c) => Array.isArray(c.recipients)),
    withRecipientIds: count((c) => Array.isArray(c.recipient_ids)),
    unresolvedRecipients: count((c) => !c.recipients && (c.recipient_ids ?? []).some((id) => !users.has(id))),
    isMessageRequest: count((c) => 'is_message_request' in c),
    isSpam: count((c) => 'is_spam' in c),
  };
}

/**
 * Each READY names core's signed-in account, then hands it that account's DM list. Core takes calls in order, so every
 * later delta and query sees this account. Subscribe before the client opens its socket (as the tap requires), or READY
 * is missed.
 */
export function watchPrivateChannels(tap: GatewayTap, core: Pick<MainCore, 'call'>, diag: (event: string, data: Record<string, unknown>) => void): void {
  tap.on('dispatch', ({ t, d }) => {
    if (t !== 'READY') return;
    const ready = d as Record<string, unknown>;
    diag('private-channels-ready', privateChannelsShape(ready));
    const list = readyPrivateChannels(ready);
    if (!list) return;
    void core.call('setSelf', list.self);
    void core.call('replacePrivateChannels', list.self.id, list.channels, list.partial);
  });
}
