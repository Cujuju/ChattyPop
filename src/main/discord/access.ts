// Reads channel access from gateway server owners, channel overwrites and owner roles, including READY and supplemental member payloads.
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

/** The access facts a dispatch carries, with self's own roles (the account OwnerSession names for its socket); null for other events. */
export function gatewayAccessFacts(t: string, d: unknown, self: string | null): AccessFacts | null {
  const f: AccessFacts = { owners: [], overwrites: [], members: [] };
  switch (t) {
    case 'READY': {
      const r = d as { guilds?: GatewayGuild[]; merged_members?: MergedMember[][] };
      (r.guilds ?? []).forEach((g) => addGuild(f, g));
      addMerged(f, r.guilds ?? [], r.merged_members, self);
      return f;
    }
    // Newer clients get the owner's memberships here, after READY.
    case 'READY_SUPPLEMENTAL': {
      const r = d as { guilds?: { id: string }[]; merged_members?: MergedMember[][] };
      addMerged(f, r.guilds ?? [], r.merged_members, self);
      return f;
    }
    case 'GUILD_CREATE': {
      const g = d as GatewayGuild;
      addGuild(f, g);
      const me = g.members?.find((m) => m.user?.id === self);
      if (self && me?.roles) f.members.push({ guildId: g.id, userId: self, nick: me.nick ?? null, roles: me.roles, communicationDisabledUntil: me.communication_disabled_until });
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
function addMerged(f: AccessFacts, guilds: { id: string }[], merged: MergedMember[][] | undefined, self: string | null): void {
  guilds.forEach((g, i) => {
    const me = merged?.[i]?.find((m) => m.user_id === self);
    if (me?.roles) f.members.push({ guildId: g.id, userId: me.user_id, nick: me.nick ?? null, roles: me.roles, communicationDisabledUntil: me.communication_disabled_until });
  });
}
