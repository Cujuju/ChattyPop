// A custom emoji's server for its popout: the account's own servers from the gateway, others from Discord's emoji source,
// asked through the embedded client's session as its popout asks.
import type { RawGuild } from '@shared/discord';
import { DiscordHttpError } from '@shared/discord';
import type { EmojiSource, EmojiSourceGuild, GuildEmoji } from '@shared/emoji';
import type { DiscordReader } from './client';

/** Discord's server feature for a server listed in Server Discovery. */
const DISCOVERABLE = 'DISCOVERABLE';
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;

/** GET emojis/{id}/source's fields read here. */
interface RawEmojiSource {
  type?: unknown;
  guild?: { id?: unknown; name?: unknown; icon?: unknown; features?: unknown } | null;
}

const sourceGuild = (g: { id: string; name: string; icon?: string | null; features?: readonly unknown[] }): EmojiSourceGuild => ({
  id: g.id,
  name: g.name,
  icon: g.icon ?? null,
  discoverable: (g.features ?? []).includes(DISCOVERABLE),
});

/** A source answer's server; null when it names none usable (an app's emoji, or a server Discord keeps private). */
export function sourceFromAnswer(raw: RawEmojiSource): EmojiSourceGuild | null {
  const g = raw.guild;
  if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') return null;
  return sourceGuild({
    id: g.id,
    name: g.name,
    icon: typeof g.icon === 'string' ? g.icon : null,
    features: Array.isArray(g.features) ? g.features : [],
  });
}

/** Answers are kept for the session: an emoji never moves server. A refusal (4xx) is an answer too: no server named. */
export class EmojiSources {
  private readonly asked = new Map<string, Promise<EmojiSourceGuild | null>>();

  constructor(
    private readonly owner: DiscordReader,
    private readonly emojis: { all(): GuildEmoji[] },
    private readonly guilds: () => RawGuild[],
  ) {}

  async of(emojiId: string): Promise<EmojiSource> {
    const own = this.emojis.all().find((e) => e.id === emojiId);
    const guild = own && this.guilds().find((g) => g.id === own.guildId);
    if (guild) return { guild: sourceGuild(guild), joined: true };
    const found = await this.ask(emojiId);
    // A server Discord names that the account is in (its emoji just not indexed yet) reads as joined.
    return { guild: found, joined: !!found && this.guilds().some((g) => g.id === found.id) };
  }

  private ask(emojiId: string): Promise<EmojiSourceGuild | null> {
    const had = this.asked.get(emojiId);
    if (had) return had;
    const read = this.owner.get<RawEmojiSource>(`emojis/${emojiId}/source`).then(sourceFromAnswer, (err: unknown) => {
      if (err instanceof DiscordHttpError && err.status >= CLIENT_ERROR_MIN && err.status < SERVER_ERROR_MIN) return null;
      throw err;
    });
    this.asked.set(emojiId, read);
    // A failure (offline, a server error) is asked again next time.
    void read.catch(() => this.asked.get(emojiId) === read && this.asked.delete(emojiId));
    return read;
  }
}
