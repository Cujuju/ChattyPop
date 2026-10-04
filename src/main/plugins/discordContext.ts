// A plugin main side's Discord services (docs/plugin-architecture.md §4): reads for every plugin; writes only for one
// whose descriptor declares `discord: { write: true }`, absent otherwise by type and at run time, and refused while posting
// is locked (./posting.ts). Law 4: the embedded session only.
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { GuildEmoji } from '@shared/emoji';
import type { DiscordClient, DiscordQuery, DiscordReader, WriteOptions } from '../discord/client';
import type { GuildEmojiIndex } from '../discord/guildEmojis';
import { postingClient, type PostingGate } from './posting';

/** Posting on the owner's behalf: writes aren't paced, so a post's one wait is this pause. */
export interface AutomaticPosting {
  /** Waits the owner's automatic-post pause (Settings → Archive), randomized. Call once per post, before its first write. */
  humanPause(): Promise<void>;
}

/** The Discord client plugin `D` gets: writes only when it declares `discord: { write: true }`. */
export type PluginDiscord<D extends PluginDescriptor> = D extends { discord: { write: true } } ? DiscordClient & AutomaticPosting : DiscordReader;

/** What the host hands every plugin's Discord services. */
export interface PluginDiscordDeps {
  /** Paced: plugin reads are background work. */
  paced: DiscordClient;
  /** Not held back: an automatic post waits only for its humanPause. */
  prompt: DiscordClient;
  humanPause(): Promise<void>;
  /** Writes refuse with PostingLocked while posting is locked, reactions and acks excepted (./posting.ts). */
  posting: PostingGate;
}

/** Custom emojis, per server. */
export interface GuildEmojis {
  /** Every server's the gateway reported, grouped by server. */
  all(): GuildEmoji[];
  /** One server's usable ones, fetched through the session when the gateway didn't report them. */
  forGuild(guildId: string): Promise<GuildEmoji[]>;
}

/** Plugin `plugin`'s view of Discord: only `get` unless it declares Discord writes; no member reaches the API itself. */
export function pluginDiscord<D extends PluginDescriptor>(plugin: D, d: PluginDiscordDeps): PluginDiscord<D> {
  const reader: DiscordReader = { get: <T>(path: string, query?: DiscordQuery) => d.paced.get<T>(path, query) };
  if (plugin.discord?.write !== true) return reader as PluginDiscord<D>;
  const writer = postingClient(d.prompt, d.posting);
  const client: DiscordClient & AutomaticPosting = {
    ...reader,
    post: <T>(path: string, json: unknown, opts?: WriteOptions) => writer.post<T>(path, json, opts),
    postOnce: <T>(path: string, json: unknown, opts?: WriteOptions) => writer.postOnce<T>(path, json, opts),
    put: (path, opts) => writer.put(path, opts),
    patch: <T>(path: string, json: unknown, opts?: WriteOptions) => writer.patch<T>(path, json, opts),
    delete: (path, opts) => writer.delete(path, opts),
    upload: (uploadUrl, bytes) => writer.upload(uploadUrl, bytes),
    humanPause: () => d.humanPause(),
  };
  return client as PluginDiscord<D>;
}

/** `index` read through `api`, the reader every plugin has. */
export const guildEmojis = (index: Pick<GuildEmojiIndex, 'all' | 'forGuild'>, api: DiscordReader): GuildEmojis => ({
  all: () => index.all(),
  forGuild: (guildId) => index.forGuild(api, guildId),
});
