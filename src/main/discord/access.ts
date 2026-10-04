// Who can see a channel, read from the client's gateway traffic: servers' owners (READY, GUILD_CREATE, GUILD_UPDATE),
// channels' overwrites (those and CHANNEL_CREATE/UPDATE) and the owner's roles (READY's or READY_SUPPLEMENTAL's
// merged_members, GUILD_CREATE's members).
import type { RawChannel } from '@shared/discord';
import type { AccessFacts } from '@shared/permissions';

/** A server as user-account dispatches send it: name and owner sit under `properties` in READY and GUILD_CREATE. */
interface GatewayGuild {
  id: string;
  name?: string;
  owner_id?: string;
  properties?: { name?: string; owner_id?: string };
  channels?: RawChannel[];
  members?: { user?: { id: string }; nick?: string | null; roles?: string[]; communication_disabled_until?: string | null }[];
}

type MergedMember = { user_id: string; nick?: string | null; roles?: string[]; communication_disabled_until?: string | null };

function addChannels(f: AccessFacts, channels: RawChannel[]): void {
  for (const c of channels) if (c.permission_overwrites) f.overwrites.push({ channelId: c.id, overwrites: c.permission_overwrites });
}

function addGuild(f: AccessFacts, g: GatewayGuild): void {
  const ownerId = g.owner_id ?? g.properties?.owner_id;
  if (ownerId) f.owners.push({ guildId: g.id, name: g.name ?? g.properties?.name ?? null, ownerId });
  addChannels(f, g.channels ?? []);
}

/** Reads access facts from dispatches; remembers the signed-in user (READY) to pick their own roles. */
export class GatewayAccess {
  private self: string | null = null;

  /** The facts a dispatch carries; null for other events. */
  read(t: string, d: unknown): AccessFacts | null {
    const f: AccessFacts = { owners: [], overwrites: [], members: [] };
    switch (t) {
      case 'READY': {
        const r = d as { user?: { id: string }; guilds?: GatewayGuild[]; merged_members?: MergedMember[][] };
        this.self = r.user?.id ?? null;
        (r.guilds ?? []).forEach((g) => addGuild(f, g));
        this.addMerged(f, r.guilds ?? [], r.merged_members);
        return f;
      }
      // Newer clients get the owner's memberships here, after READY.
      case 'READY_SUPPLEMENTAL': {
        const r = d as { guilds?: { id: string }[]; merged_members?: MergedMember[][] };
        this.addMerged(f, r.guilds ?? [], r.merged_members);
        return f;
      }
      case 'GUILD_CREATE': {
        const g = d as GatewayGuild;
        addGuild(f, g);
        const me = g.members?.find((m) => m.user?.id === this.self);
        if (this.self && me?.roles) f.members.push({ guildId: g.id, userId: this.self, nick: me.nick ?? null, roles: me.roles, communicationDisabledUntil: me.communication_disabled_until });
        return f;
      }
      case 'GUILD_UPDATE':
        addGuild(f, d as GatewayGuild);
        return f;
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        addChannels(f, [d as RawChannel]);
        return f;
      default:
        return null;
    }
  }

  /** `merged_members` runs parallel to `guilds`: the owner's own membership in each. */
  private addMerged(f: AccessFacts, guilds: { id: string }[], merged: MergedMember[][] | undefined): void {
    guilds.forEach((g, i) => {
      const me = merged?.[i]?.find((m) => m.user_id === this.self);
      if (me?.roles) f.members.push({ guildId: g.id, userId: me.user_id, nick: me.nick ?? null, roles: me.roles, communicationDisabledUntil: me.communication_disabled_until });
    });
  }
}
