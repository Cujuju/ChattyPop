// Creates archive fixtures through real Archive ingestion, preserving derivation and privacy behavior.
import { snowflakeFromMs, type RawMessage, type RawUser } from '@shared/discord';
import type { ChannelPolicy } from '@shared/contract';
import { SETTINGS_KEYS } from '@shared/settings';
import type { Archive } from '@core/archive';
import { ARRIVAL } from '@core/arrival';
import { setSetting, type Db } from '@core/db';
import type { SeedArchive, SeedChannel, SeedGuild, SeedMessage } from './types';

/** Discord's channel types for a server text channel and a public thread under one. */
const GUILD_TEXT_CHANNEL = 0;
const PUBLIC_THREAD = 11;
/** The server channels go in when a test seeds none. */
const DEFAULT_GUILD: SeedGuild = { id: '1000000000000000001', name: 'Server' };
/** The author of a message that names none. */
const DEFAULT_AUTHOR: RawUser = { id: 'u1', username: 'alice', global_name: 'Alice' };

/** Stores `seed`'s servers and channels (with their marks), privacy mode, then its messages; none reaches a plugin. */
export function seedArchive(db: Db, archive: Archive, seed: SeedArchive, now: () => number): void {
  const guilds = seed.guilds?.length ? seed.guilds : [DEFAULT_GUILD];
  archive.upsertGuilds(guilds.map((g) => ({ id: g.id, name: g.name ?? g.id })));
  for (const g of guilds) if (g.hidden) archive.setGuildHideInPrivacy(g.id, true);
  for (const c of seed.channels ?? []) {
    archive.upsertChannels(c.guildId ?? guilds[0]!.id, [
      { id: c.id, name: c.name ?? c.id, type: c.parentId ? PUBLIC_THREAD : GUILD_TEXT_CHANNEL, parent_id: c.parentId ?? null },
    ]);
    if (c.optIn !== false) archive.setOptIn(c.id, true);
    archive.setChannelPolicy(c.id, channelPolicy(c));
  }
  if (seed.privacyMode) setSetting(db, SETTINGS_KEYS.privacyMode, true);
  // History: synced before the plugin starts.
  if (seed.messages?.length) archive.ingestMessages(seed.messages.map((m) => rawMessage(m, now)), ARRIVAL.sync);
}

/** A channel's local-AI-only and privacy marks, as the channel list sets them; fields left out stay as they are. */
export function channelPolicy(policy: Pick<SeedChannel, 'localOnly' | 'hidden'>): ChannelPolicy {
  return { localAiOnly: policy.localOnly, hideInPrivacy: policy.hidden };
}

let sent = 0;
/** A Discord message from plain fields: its id a snowflake from its time, unique within the run. */
export function rawMessage(m: SeedMessage, now: () => number): RawMessage {
  const ts = m.ts ?? now();
  const author: RawUser = m.authorId === undefined && m.authorName === undefined
    ? DEFAULT_AUTHOR
    : { id: m.authorId ?? DEFAULT_AUTHOR.id, username: m.authorName ?? m.authorId!, global_name: m.authorName ?? null };
  return {
    id: m.id ?? snowflakeFromMs(ts, ++sent),
    channel_id: m.channelId,
    author,
    content: m.content,
    timestamp: new Date(ts).toISOString(),
    edited_timestamp: null,
    ...m.extra,
  };
}
