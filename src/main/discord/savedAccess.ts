// New saves use current native channel access, without asking Discord for metadata.
import type { CoreClient } from '../coreClient';
import type { GatewayDirectory } from './directory';
import type { GatewayTap } from './gatewayTap';
import type { OwnerSession } from './ownerSession';

export class SavedAccess {
  private readonly threads = new Map<string, { parent: string; guild: string }>();
  private readonly removedMembership = new Set<string>();
  private socket: string | null = null;
  constructor(tap: Pick<GatewayTap, 'on'>, private readonly owner: Pick<OwnerSession, 'current' | 'accountOf'>, private readonly directory: Pick<GatewayDirectory, 'channelsOf'>, private readonly core: Pick<CoreClient, 'call'>) {
    tap.on('sent', ({ op, socketId }) => {
      if ((op !== 2 && op !== 6) || !socketId) return;
      this.socket = socketId;
      if (op === 2) { this.threads.clear(); this.removedMembership.clear(); }
    });
    tap.on('dispatch', ({ t, d, socketId }) => {
      if (!this.socket || socketId !== this.socket) return;
      if (!d || typeof d !== 'object') return;
      const data = d as Record<string, unknown>;
      const remember = (value: unknown, guild?: string): void => {
        if (!value || typeof value !== 'object') return;
        const c = value as { id?: unknown; parent_id?: unknown; guild_id?: string };
        const ownerGuild = c.guild_id ?? guild;
        if (typeof c.id === 'string' && typeof c.parent_id === 'string' && typeof ownerGuild === 'string' && ownerGuild) this.threads.set(c.id, { parent: c.parent_id, guild: ownerGuild });
      };
      if (t === 'READY') {
        this.threads.clear();
        this.removedMembership.clear();
        for (const guild of Array.isArray(data.guilds) ? data.guilds : []) for (const thread of guild.threads ?? []) remember(thread, guild.id);
      } else if (t === 'THREAD_CREATE' || t === 'THREAD_UPDATE') remember(data);
      else if (t === 'THREAD_DELETE' && typeof data.id === 'string') this.threads.delete(data.id);
      else if (t === 'THREAD_LIST_SYNC') {
        for (const [id, c] of this.threads) if (c.guild === data.guild_id && (!data.channel_ids || (Array.isArray(data.channel_ids) && data.channel_ids.includes(c.parent)))) this.threads.delete(id);
        for (const thread of Array.isArray(data.threads) ? data.threads : []) remember(thread, typeof data.guild_id === 'string' ? data.guild_id : undefined);
      } else if (t === 'THREAD_MEMBERS_UPDATE' && typeof data.id === 'string') {
        const self = owner.accountOf(socketId);
        if (Array.isArray(data.removed_member_ids) && data.removed_member_ids.includes(self)) this.removedMembership.add(data.id);
        if (Array.isArray(data.added_members) && data.added_members.some((m) => m.user_id === self || m.member?.user?.id === self)) this.removedMembership.delete(data.id);
      }
    });
  }
  async channels(accountId: string): Promise<string[]> {
    if (typeof accountId !== 'string' || !accountId || this.owner.current()?.account !== accountId) return [];
    const socket = this.socket;
    const rules = await this.core.call('savedWritableChannels', accountId);
    if (this.owner.current()?.account !== accountId || socket !== this.socket) return [];
    return rules.filter((c) => c.guildId === null || (this.directory.channelsOf(c.guildId)?.some((native) => native.id === (c.parentId ?? c.channelId)) && (!c.privateThread || (this.threads.has(c.channelId) && !this.removedMembership.has(c.channelId))))).map((c) => c.channelId);
  }
}
