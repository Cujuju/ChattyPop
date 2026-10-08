// Discord's picker data, read only through the embedded client's request session.
import type { EmojiPickerData } from '@shared/compose';
import { DM_GUILD_ID } from '@shared/discord';
import { errorMessage } from '@shared/errors';
import type { DiscordReader } from './client';
import type { GatewayTap } from './gatewayTap';
import { fields, has, message } from './settingsProto';

// Schema: discord-userdoccers/discord-protos, FrecencyUserSettings.favorite_emojis (5) → emojis (1).
const FAVORITES = 5;
const FAVORITE_KEY = 1;
const SETTINGS_TYPE = 2;
const SETTINGS_PATH = 'users/@me/settings-proto/2';
const FAVORITES_TTL_MS = 60_000;
const POPULAR_TTL_MS = 5 * 60_000;

/** null means a partial update without favorites; an empty favorites message clears the list. */
export function emojiFavoritesFromProto(proto: Buffer): string[] | null {
  const top = fields(proto);
  if (!has(top, FAVORITES)) return null;
  return [...new Set(message(top, FAVORITES).flatMap((f) => f.no === FAVORITE_KEY && 'bytes' in f ? [f.bytes.toString('utf8')] : []).filter(Boolean))];
}

/** On-demand reads are cached; gateway updates keep favorites current between picker openings. */
export class DiscordEmojiPickerData {
  private favorites: string[] = [];
  private favoritesUntil = 0;
  private favoriteRead: Promise<void> | undefined;
  private generation = 0;
  private readonly top = new Map<string, { until: number; read: Promise<string[]> }>();

  constructor(tap: GatewayTap, private readonly owner: DiscordReader) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') {
        this.generation++;
        this.favorites = [];
        this.favoritesUntil = 0;
        this.favoriteRead = undefined;
        this.top.clear();
      } else if (t === 'USER_SETTINGS_PROTO_UPDATE') {
        const u = d as { settings?: { type?: number; proto?: unknown }; partial?: boolean };
        if (u.settings?.type !== SETTINGS_TYPE || typeof u.settings.proto !== 'string') return;
        try {
          const next = emojiFavoritesFromProto(Buffer.from(u.settings.proto, 'base64'));
          if (next !== null || !u.partial) {
            this.generation++;
            this.favorites = next ?? [];
            this.favoritesUntil = Date.now() + FAVORITES_TTL_MS;
          }
        } catch {
          this.favoritesUntil = 0; // The next picker read retries from Discord.
        }
      }
    });
  }

  private async readFavorites(): Promise<void> {
    if (Date.now() < this.favoritesUntil) return;
    if (!this.favoriteRead) {
      const generation = this.generation;
      const read = this.owner.get<{ settings: string }>(SETTINGS_PATH).then(({ settings }) => {
        const next = emojiFavoritesFromProto(Buffer.from(settings, 'base64')) ?? [];
        if (generation === this.generation) {
          this.favorites = next;
          this.favoritesUntil = Date.now() + FAVORITES_TTL_MS;
        }
      });
      this.favoriteRead = read;
      void read.finally(() => { if (this.favoriteRead === read) this.favoriteRead = undefined; }).catch(() => undefined);
    }
    await this.favoriteRead;
  }

  private popular(guildId: string): Promise<string[]> {
    if (guildId === DM_GUILD_ID) return Promise.resolve([]);
    const cached = this.top.get(guildId);
    if (cached && Date.now() < cached.until) return cached.read;
    const read = this.owner.get<{ items: { emoji_id: string; emoji_rank: number }[] }>(`guilds/${guildId}/top-emojis`)
      .then(({ items }) => [...items].sort((a, b) => a.emoji_rank - b.emoji_rank).map((e) => e.emoji_id));
    this.top.set(guildId, { until: Date.now() + POPULAR_TTL_MS, read });
    void read.catch(() => { if (this.top.get(guildId)?.read === read) this.top.delete(guildId); });
    return read;
  }

  async get(guildId: string): Promise<EmojiPickerData> {
    const [favorites, popular] = await Promise.allSettled([this.readFavorites(), this.popular(guildId)]);
    return {
      favorites: favorites.status === 'fulfilled' ? [...this.favorites] : [],
      popular: popular.status === 'fulfilled' ? popular.value : [],
      ...(favorites.status === 'rejected' ? { favoritesError: errorMessage(favorites.reason) } : {}),
      ...(popular.status === 'rejected' ? { popularError: errorMessage(popular.reason) } : {}),
    };
  }
}
