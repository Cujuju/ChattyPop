// Live Discord gateway events main forwards (ARCHIVED_GATEWAY_EVENTS), applied to the archive as they arrive.
import type { ArchivedGatewayEvent } from '@shared/contract';
import { DM_CHANNEL_TYPES, snowflakeToMs, type RawMember, type RawMessage, type RawMessageUpdate, type RawPrivateChannel, type RawRole, type RawThread, type RawUser } from '@shared/discord';
import type { Archive } from './archive';
import { ARRIVAL } from './arrival';

export interface GatewayDeps {
  /** A channel's archived messages changed ('' = no one channel). */
  changed(channelId: string): void;
  /** Start of the history window sync fills; older threads aren't archived. */
  backfillFromMs(): number;
  /** The signed-in user; null until main has said. */
  selfId(): string | null;
  /** A DM's newest message id rose (dm-activity): one row changed, not the list. */
  dmActivity(channelId: string, lastMessageId: string): void;
  /** When auto-archiving DMs was turned on (ms); null while off. */
  autoArchiveSinceMs(): number | null;
  /** Auto-archive opted this DM in, before its message was stored. */
  optedIn(channelId: string): void;
}

export function applyGatewayEvent(a: Archive, t: ArchivedGatewayEvent, d: unknown, deps: GatewayDeps): void {
  switch (t) {
    case 'MESSAGE_CREATE': {
      const m = d as RawMessage;
      // Every DM's activity is kept, archived or not; ingest stores content only for archived channels. A server's
      // message (it names its server) costs no lookup.
      if (!m.guild_id) {
        const touch = a.touchChannel(m.channel_id, m.id);
        if (touch.rose) deps.dmActivity(m.channel_id, m.id);
        // A closed DM opened again: the list changed.
        if (touch.reopened) deps.changed('');
        // Auto-archive opts the DM in before ingest, so this first message is stored.
        const since = deps.autoArchiveSinceMs();
        if (since !== null && snowflakeToMs(m.id) > since && a.autoArchive(m.channel_id, deps.selfId())) deps.optedIn(m.channel_id);
      }
      if (a.ingestMessages([m], ARRIVAL.gateway).inserted) deps.changed(m.channel_id);
      return;
    }
    case 'MESSAGE_UPDATE': {
      const u = d as RawMessageUpdate;
      if (a.isOptedIn(u.channel_id)) {
        a.applyUpdate(u);
        deps.changed(u.channel_id);
      }
      return;
    }
    case 'MESSAGE_DELETE': {
      const { id, channel_id } = d as { id: string; channel_id: string };
      if (a.isOptedIn(channel_id)) {
        a.markDeleted(channel_id, id, Date.now());
        deps.changed(channel_id);
      }
      return;
    }
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
    case 'MESSAGE_REACTION_REMOVE_ALL':
    case 'MESSAGE_REACTION_REMOVE_EMOJI': {
      const r = d as Parameters<Archive['applyReaction']>[1];
      if (a.applyReaction(t, r, deps.selfId())) deps.changed(r.channel_id);
      return;
    }
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      a.upsertThreads([d as RawThread], deps.backfillFromMs());
      return;
    case 'THREAD_LIST_SYNC':
      a.upsertThreads((d as { threads?: RawThread[] }).threads ?? [], deps.backfillFromMs());
      return;
    // Server nicknames: the name Discord shows for a person. Chunks answer the client's requests for the authors it renders.
    // Name writes report themselves (nameWrites.ts).
    case 'GUILD_MEMBERS_CHUNK': {
      const c = d as { guild_id: string; members?: RawMember[] };
      a.upsertMembers(c.guild_id, c.members ?? []);
      return;
    }
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE': {
      const m = d as RawMember & { guild_id: string };
      a.upsertMembers(m.guild_id, [m]);
      return;
    }
    case 'GUILD_MEMBER_REMOVE': {
      const r = d as { guild_id: string; user?: { id?: string } };
      if (!r.user?.id) return;
      a.markMemberLeft(r.guild_id, r.user.id);
      return;
    }
    case 'GUILD_MEMBER_LIST_UPDATE': {
      // The member sidebar: SYNC ops carry `items`, INSERT/UPDATE one `item`; group headers carry no member.
      const l = d as { guild_id: string; ops?: { items?: { member?: RawMember }[]; item?: { member?: RawMember } }[] };
      const members = (l.ops ?? []).flatMap((op) => [...(op.items ?? []), ...(op.item ? [op.item] : [])]).flatMap((i) => (i.member ? [i.member] : []));
      a.upsertMembers(l.guild_id, members);
      return;
    }
    // Roles colour and mark members' names; READY and GUILD_CREATE lists arrive through replaceGuildRoles.
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE': {
      const r = d as { guild_id: string; role: RawRole };
      a.applyRoleChange({ kind: 'put', guildId: r.guild_id, role: r.role });
      return;
    }
    case 'GUILD_ROLE_DELETE':
      a.applyRoleChange({ kind: 'delete', roleId: (d as { role_id: string }).role_id });
      return;
    case 'MESSAGE_DELETE_BULK': {
      const { ids, channel_id } = d as { ids: string[]; channel_id: string };
      if (a.isOptedIn(channel_id)) {
        const now = Date.now();
        ids.forEach((id) => a.markDeleted(channel_id, id, now));
        deps.changed(channel_id);
      }
      return;
    }
    // DMs and group DMs only; server channels arrive through the directory's own fetches.
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'CHANNEL_DELETE': {
      const c = d as RawPrivateChannel;
      if (!DM_CHANNEL_TYPES.has(c.type)) return;
      if (t !== 'CHANNEL_DELETE') a.upsertPrivateChannel(deps.selfId(), c, t === 'CHANNEL_CREATE');
      else if (!a.closePrivateChannel(c.id, Date.now())) return;
      deps.changed('');
      return;
    }
    case 'CHANNEL_RECIPIENT_ADD':
    case 'CHANNEL_RECIPIENT_REMOVE': {
      const r = d as { channel_id: string; user: RawUser };
      if (a.changeRecipient(r.channel_id, r.user, t === 'CHANNEL_RECIPIENT_ADD', deps.selfId())) deps.changed('');
      return;
    }
    default:
      // Every forwarded event needs a case: a new ARCHIVED_GATEWAY_EVENTS entry fails to compile here until handled.
      t satisfies never;
  }
}
