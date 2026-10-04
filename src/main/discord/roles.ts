import type { GuildRole } from '@shared/commands';
import type { RawRole } from '@shared/discord';
import type { GatewayTap } from './gatewayTap';
import { GuildIndex } from './guildIndex';

/** Each server's full role list in READY (every server) or GUILD_CREATE (one); a server sent without roles is left out. */
export function gatewayGuildRoles(t: string, d: unknown): { guildId: string; roles: RawRole[] }[] {
  type G = { id: string; roles?: RawRole[] };
  const guilds = t === 'READY' ? ((d as { guilds?: G[] }).guilds ?? []) : t === 'GUILD_CREATE' ? [d as G] : [];
  return guilds.flatMap((g) => (g.roles ? [{ guildId: g.id, roles: g.roles }] : []));
}

/** Highest role first, as Discord lists them. */
const usable = (guildId: string, raw: RawRole[]): GuildRole[] =>
  [...raw]
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => ({ id: r.id, name: r.name, color: r.color || null, guildId }));

/** Every server's roles, kept from the gateway (GuildIndex), for role options and role menus. */
export class GuildRoleIndex extends GuildIndex<RawRole, GuildRole> {
  constructor(tap: GatewayTap) {
    super(tap, {
      field: 'roles',
      updateEvent: null,
      staleEvents: ['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE'],
      path: (id) => `guilds/${id}/roles`,
      usable,
    });
  }
}
