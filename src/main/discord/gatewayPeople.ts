// Project identity-bearing dispatches before IPC: READY includes large unrelated lists and private account fields.
import type { ArchivedGatewayEvent } from '@shared/contract';
import type { GatewayGuildPeople, GatewayReadyPeople, RawMemberPatch, RawUserPatch } from '@shared/discord';

function pick<T extends object, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of fields) if (value[key] !== undefined) result[key] = value[key];
  return result as Pick<T, K>;
}

function userFacts(u: RawUserPatch): RawUserPatch {
  const facts = pick(u, ['id', 'username', 'global_name', 'avatar', 'bot', 'primary_guild', 'display_name_styles', 'avatar_decoration_data']);
  if (facts.primary_guild) facts.primary_guild = pick(facts.primary_guild, ['identity_guild_id', 'identity_enabled', 'tag', 'badge']);
  if (facts.display_name_styles) facts.display_name_styles = pick(facts.display_name_styles, ['font_id', 'effect_id', 'colors']);
  if (facts.avatar_decoration_data) facts.avatar_decoration_data = pick(facts.avatar_decoration_data, ['asset', 'sku_id']);
  return facts;
}

function memberFacts(m: RawMemberPatch): RawMemberPatch {
  const facts = pick(m, ['user_id', 'nick', 'roles', 'communication_disabled_until']);
  return m.user ? { ...facts, user: userFacts(m.user) } : facts;
}

function guildFacts(g: GatewayGuildPeople): GatewayGuildPeople {
  return {
    id: g.id,
    members: (g.members ?? []).map(memberFacts),
    presences: (g.presences ?? []).flatMap((p) => p.user ? [{ user: userFacts(p.user) }] : []),
  };
}

/** Existing message events keep their archive payload; new identity events send only facts core consumes. */
export function gatewayArchivePayload(t: ArchivedGatewayEvent, d: unknown): unknown {
  switch (t) {
    case 'READY':
    case 'READY_SUPPLEMENTAL': {
      const r = d as GatewayReadyPeople;
      return {
        ...(r.user ? { user: userFacts(r.user) } : {}),
        users: (r.users ?? []).map(userFacts),
        guilds: (r.guilds ?? []).map(guildFacts),
        merged_members: (r.merged_members ?? []).map((members) => members.map(memberFacts)),
      } satisfies GatewayReadyPeople;
    }
    case 'GUILD_CREATE':
      return guildFacts(d as GatewayGuildPeople);
    case 'USER_UPDATE':
      return userFacts(d as RawUserPatch);
    case 'PRESENCE_UPDATE': {
      const p = d as { user?: RawUserPatch };
      return p.user ? { user: userFacts(p.user) } : {};
    }
    default:
      return d;
  }
}
