// Each server's Boost level (premium_tier), which can raise the upload limit (uploadLimitBytes).
import type { GatewayTap } from './gatewayTap';

/** User-account dispatches carry most server fields under `properties` (READY, GUILD_CREATE); GUILD_UPDATE carries them at the top. */
interface RawGuild {
  id: string;
  premium_tier?: number;
  properties?: { premium_tier?: number };
}

export class GuildTiers {
  private readonly tiers = new Map<string, number>();

  /** Subscribe before the client opens its socket, or READY is missed. */
  constructor(tap: GatewayTap) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') {
        this.tiers.clear();
        for (const g of (d as { guilds?: RawGuild[] }).guilds ?? []) this.set(g);
      } else if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') this.set(d as RawGuild);
      else if (t === 'GUILD_DELETE') this.tiers.delete((d as RawGuild).id);
    });
  }

  /** The server's Boost level; null when unknown. */
  tier(guildId: string): number | null {
    return this.tiers.get(guildId) ?? null;
  }

  private set(g: RawGuild): void {
    const tier = g.premium_tier ?? g.properties?.premium_tier;
    if (typeof tier === 'number') this.tiers.set(g.id, tier);
  }
}
