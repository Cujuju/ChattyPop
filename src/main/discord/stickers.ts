import type { GuildSticker, Sticker, StickerPack } from '@shared/compose';
import type { DiscordReader } from './client';
import type { GatewayTap } from './gatewayTap';
import { GuildIndex } from './guildIndex';

/** A sticker as the gateway, a server's sticker list and the sticker packs return it (the fields read here). */
interface RawSticker {
  id: string;
  name: string;
  format_type: number;
  tags?: string;
  /** false when the server lost the boost level that allowed it. */
  available?: boolean;
}

interface RawStickerPack {
  id: string;
  name: string;
  stickers: RawSticker[];
}

const toSticker = (s: RawSticker): Sticker => ({ id: s.id, name: s.name, formatType: s.format_type, tags: s.tags ?? '' });

const usable = (guildId: string, raw: RawSticker[]): GuildSticker[] =>
  raw
    .filter((s) => s.available !== false)
    .map((s) => ({ ...toSticker(s), guildId }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Every server's stickers, kept from the gateway (GuildIndex). */
export class GuildStickerIndex extends GuildIndex<RawSticker, GuildSticker> {
  constructor(tap: GatewayTap) {
    super(tap, { field: 'stickers', updateEvent: 'GUILD_STICKERS_UPDATE', path: (id) => `guilds/${id}/stickers`, usable });
  }
}

/** Discord's standard sticker packs, fetched once per run (they change with Discord releases, not during a session). */
export class StickerPacks {
  private packs: Promise<StickerPack[]> | null = null;

  get(api: DiscordReader): Promise<StickerPack[]> {
    this.packs ??= api.get<{ sticker_packs: RawStickerPack[] }>('sticker-packs').then(
      (r) => r.sticker_packs.map((p) => ({ id: p.id, name: p.name, stickers: p.stickers.map(toSticker) })),
      (err: unknown) => {
        this.packs = null; // try again next time
        throw err;
      },
    );
    return this.packs;
  }
}
