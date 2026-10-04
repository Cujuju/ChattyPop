import { diag } from '../diagnostics';
import type { DiscordReader } from './client';
import type { GatewayTap } from './gatewayTap';

/** How one kind of per-server list (emoji, stickers, roles) arrives from the gateway and the REST API. */
export interface GuildIndexSpec<Raw, Item> {
  /** The guild field holding the list in READY and GUILD_CREATE; absent when the gateway sent the guild unavailable or partial. */
  field: 'emojis' | 'stickers' | 'roles';
  /** The dispatch replacing one server's list: `{ guild_id, [field]: Raw[] }`; null when changes arrive one item at a time. */
  updateEvent: string | null;
  /** Dispatches changing one item of a server's list (`{ guild_id, … }`): that list is fetched again when next asked for. */
  staleEvents?: readonly string[];
  /** REST path of one server's list. */
  path: (guildId: string) => string;
  /** The items that can be used now, in display order. */
  usable: (guildId: string, raw: Raw[]) => Item[];
}

type GatewayGuild<Raw> = { id: string } & Partial<Record<GuildIndexSpec<Raw, unknown>['field'], Raw[]>>;

/**
 * Every server's list, read from the embedded client's own gateway traffic (READY, GUILD_CREATE, the update event), so
 * listing all servers costs no requests. A server the gateway didn't cover is fetched once.
 */
export class GuildIndex<Raw, Item> {
  private readonly byGuild = new Map<string, Item[]>();

  /** Subscribe before the client opens its socket (as the tap requires), or READY is missed. */
  constructor(
    tap: GatewayTap,
    private readonly spec: GuildIndexSpec<Raw, Item>,
  ) {
    tap.on('dispatch', ({ t, d }) => this.apply(t, d));
  }

  /** One server's list: from the gateway, else fetched through the client's session and kept current from then on. */
  async forGuild(api: DiscordReader, guildId: string): Promise<Item[]> {
    const known = this.byGuild.get(guildId);
    if (known) return known;
    const list = this.spec.usable(guildId, await api.get<Raw[]>(this.spec.path(guildId)));
    this.byGuild.set(guildId, list);
    return list;
  }

  /** Every known server's items, grouped by server. */
  all(): Item[] {
    return [...this.byGuild.values()].flat();
  }

  private apply(t: string, d: unknown): void {
    switch (t) {
      case 'READY': {
        // A new session (possibly another account): only its servers count.
        this.byGuild.clear();
        for (const g of (d as { guilds?: GatewayGuild<Raw>[] }).guilds ?? []) this.setGuild(g);
        diag('guild-index-ready', { field: this.spec.field, guilds: this.byGuild.size, items: this.all().length });
        return;
      }
      case 'GUILD_CREATE':
        this.setGuild(d as GatewayGuild<Raw>);
        return;
      case 'GUILD_DELETE': {
        const g = d as { id: string; unavailable?: boolean };
        if (!g.unavailable) this.byGuild.delete(g.id); // left the server; an outage keeps its list
        return;
      }
    }
    if (t === this.spec.updateEvent) {
      const u = d as { guild_id: string } & GatewayGuild<Raw>;
      this.byGuild.set(u.guild_id, this.spec.usable(u.guild_id, u[this.spec.field] ?? []));
    } else if (this.spec.staleEvents?.includes(t)) this.byGuild.delete((d as { guild_id: string }).guild_id);
  }

  private setGuild(g: GatewayGuild<Raw>): void {
    const list = g[this.spec.field];
    if (list) this.byGuild.set(g.id, this.spec.usable(g.id, list));
  }
}
