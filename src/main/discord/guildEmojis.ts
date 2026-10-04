import type { GuildEmoji } from '@shared/emoji';
import type { GatewayTap } from './gatewayTap';
import { GuildIndex } from './guildIndex';

/** Discord's custom emoji as the gateway and the guild emoji list return it (the fields read here). */
interface RawGuildEmoji {
  id: string;
  name: string | null;
  animated?: boolean;
  /** false when the server lost the boost level that allowed it. */
  available?: boolean;
}

/** A server's custom emojis that can be used now, by name. */
const usable = (guildId: string, raw: RawGuildEmoji[]): GuildEmoji[] =>
  raw
    .filter((e): e is RawGuildEmoji & { name: string } => e.available !== false && Boolean(e.name))
    .map((e) => ({ id: e.id, name: e.name, animated: Boolean(e.animated), guildId }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Every server's custom emojis, kept from the gateway (GuildIndex). */
export class GuildEmojiIndex extends GuildIndex<RawGuildEmoji, GuildEmoji> {
  constructor(tap: GatewayTap) {
    super(tap, { field: 'emojis', updateEvent: 'GUILD_EMOJIS_UPDATE', path: (id) => `guilds/${id}/emojis`, usable });
  }
}
