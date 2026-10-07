// Servers and their channels as the client's gateway reports them (READY, GUILD_CREATE and updates): the directory costs no request.
import type { RawChannel, RawGuild } from '@shared/discord';
import type { GatewayTap } from './gatewayTap';

/** A server as user-account dispatches send it: name, icon and features sit under `properties` in READY and GUILD_CREATE. */
interface GatewayGuild {
  id: string;
  unavailable?: boolean;
  name?: string;
  icon?: string | null;
  features?: string[];
  properties?: { name?: string; icon?: string | null; features?: string[] };
  channels?: RawChannel[];
}

type ChannelEvent = RawChannel & { guild_id?: string };

/** The signed-in account's servers and their channels, kept current from the gateway. */
export class GatewayDirectory {
  private readonly guilds = new Map<string, RawGuild>();
  private readonly channels = new Map<string, Map<string, RawChannel>>();

  /** Subscribe before the client opens its socket (as the tap requires), or READY is missed. */
  constructor(tap: Pick<GatewayTap, 'on'>) {
    tap.on('dispatch', ({ t, d }) => this.apply(t, d));
  }

  /** The servers the gateway has sent; empty before READY. */
  guildList(): RawGuild[] {
    return [...this.guilds.values()];
  }

  /** One server's channels; null while the gateway hasn't sent them (before READY, or a server still unavailable). */
  channelsOf(guildId: string): RawChannel[] | null {
    const list = this.channels.get(guildId);
    return list ? [...list.values()] : null;
  }

  private apply(t: string, d: unknown): void {
    switch (t) {
      case 'READY':
        this.guilds.clear();
        this.channels.clear();
        for (const g of (d as { guilds?: GatewayGuild[] }).guilds ?? []) this.putGuild(g);
        return;
      case 'GUILD_CREATE':
      case 'GUILD_UPDATE':
        this.putGuild(d as GatewayGuild);
        return;
      case 'GUILD_DELETE': {
        const g = d as GatewayGuild;
        // Unavailable is an outage: the server stays. Otherwise the account left it.
        if (g.unavailable) return;
        this.guilds.delete(g.id);
        this.channels.delete(g.id);
        return;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const c = d as ChannelEvent;
        if (c.guild_id) this.channels.get(c.guild_id)?.set(c.id, c);
        return;
      }
      case 'CHANNEL_DELETE': {
        const c = d as ChannelEvent;
        if (c.guild_id) this.channels.get(c.guild_id)?.delete(c.id);
        return;
      }
    }
  }

  private putGuild(g: GatewayGuild): void {
    if (g.unavailable) return;
    // An update names only what it carries (a null icon is a removed one); the rest stands.
    const kept = this.guilds.get(g.id);
    const name = g.name ?? g.properties?.name ?? kept?.name;
    if (name === undefined) return;
    const icon = g.icon !== undefined ? g.icon : g.properties?.icon !== undefined ? g.properties.icon : kept?.icon;
    const features = g.features ?? g.properties?.features ?? kept?.features;
    this.guilds.set(g.id, { id: g.id, name, ...(icon !== undefined ? { icon } : {}), ...(features ? { features } : {}) });
    // GUILD_UPDATE carries no channel list: the kept one stands.
    if (g.channels) this.channels.set(g.id, new Map(g.channels.map((c) => [c.id, c])));
  }
}
