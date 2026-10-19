// Privacy mode hides marked servers/channels. Trigger-maintained hidden_ids and hidden_channels are empty when disabled.
import type { PrivacyScope } from '@shared/contract';
import type { PluginDb } from '../plugins/pluginDb';
import type { ArchiveRead } from '../plugins/pluginDb';

/** SQL true when channel id `column` is not hidden. */
export const visibleChannelSql = (column: string): string => `${column} NOT IN (SELECT id FROM hidden_channels)`;

/** Which of `channelIds` privacy mode leaves visible: an event about a hidden one reaches no view, phone or plugin. */
export const visibleChannelIds = (db: PluginDb, channelIds: string[]): Set<string> =>
  new Set(db.prepare(`SELECT value FROM json_each(?) WHERE ${visibleChannelSql('value')}`).pluck().all(JSON.stringify(channelIds)) as string[]);

/** Uncorrelated SQL guard evaluates once per statement; hidden-id scans occur per row only when privacy scope is nonempty. */
export const NOTHING_HIDDEN_SQL = 'NOT EXISTS (SELECT 1 FROM hidden_ids)';

/** People tied to places by posting, membership or a DM's recipients, with each place's id (`place`) and server (`guild`). */
const PERSON_TIES = `SELECT ca.author_id AS person, ca.channel_id AS place, c.guild_id AS guild FROM channel_authors ca JOIN channels c ON c.id = ca.channel_id
  UNION ALL SELECT user_id, NULL, guild_id FROM members
  UNION ALL SELECT peer_id, id, guild_id FROM channels WHERE peer_id IS NOT NULL
  UNION ALL SELECT r.value, c.id, c.guild_id FROM channels c, json_each(c.recipients) r WHERE c.recipients IS NOT NULL`;

/** 1 for a tie to a hidden place (a hidden channel or server), else 0; a membership has no channel. */
const HIDDEN_TIE = `(IFNULL(place IN (SELECT id FROM hidden_channels), 0) OR IFNULL(guild IN (SELECT id FROM hidden_ids), 0))`;

/**
 * SQL true when person id `column` may show: privacy mode hides one tied only to hidden places. One with no tie at all
 * (seen only in a reaction or a mention) is not tied to a place, so shows.
 */
export const visiblePersonSql = (column: string): string =>
  `(${NOTHING_HIDDEN_SQL} OR ${column} NOT IN (SELECT person FROM (${PERSON_TIES}) GROUP BY person HAVING MIN(${HIDDEN_TIE}) = 1))`;

/** SQL true when `text` holds a hidden channel or server id (no guard: callers add NOTHING_HIDDEN_SQL). */
const hiddenRefSql = (text: string): string => `EXISTS (SELECT 1 FROM hidden_ids h WHERE instr(${text}, h.id) > 0)`;

/** SQL excludes text containing hidden channel/server mentions or Discord channel links. */
export const noHiddenRefSql = (text: string): string => `(${NOTHING_HIDDEN_SQL} OR NOT ${hiddenRefSql(text)})`;

/** SQL true when message alias `m` is in a visible channel and names no hidden one. */
export const visibleMessageSql = (m: string): string => `(${visibleChannelSql(`${m}.channel_id`)} AND ${noHiddenRefSql(`${m}.content`)})`;

/** SQL true when a row about message `idColumn` in channel `channelColumn` is visible: its channel is, and the message (when archived) names no hidden id. */
export const visibleMessageRefSql = (channelColumn: string, idColumn: string): string =>
  `(${visibleChannelSql(channelColumn)} AND (${NOTHING_HIDDEN_SQL} OR NOT EXISTS (SELECT 1 FROM messages hm WHERE hm.id = ${idColumn} AND ${hiddenRefSql('hm.content')})))`;

/**
 * SQL true when a reply's preview of message @id may show: its archived copy (if any) is visible, and Discord's
 * snapshot (@channel, @text) is in a visible channel and names no hidden id. A hidden archived copy never falls back to the snapshot.
 */
export const VISIBLE_REPLY_SOURCE_SQL = `(NOT EXISTS (SELECT 1 FROM messages rm WHERE rm.id = @id AND NOT ${visibleMessageSql('rm')})
  AND ${visibleChannelSql('@channel')} AND ${noHiddenRefSql('@text')})`;

export function privacyScope(db: PluginDb): PrivacyScope {
  return {
    guildIds: db.prepare('SELECT id FROM hidden_ids WHERE id NOT IN (SELECT id FROM hidden_channels)').pluck().all() as string[],
    channelIds: db.prepare('SELECT id FROM hidden_channels').pluck().all() as string[],
  };
}

/** Stand-ins for hidden names in AI-written text. */
export const REDACTED_CHANNEL = '#private-channel';
export const REDACTED_SERVER = 'a private server';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any of `names` as a whole name (not inside a longer word or hyphenated name), with an optional leading '#'. */
function namesPattern(names: string[]): RegExp | null {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])#?(?:${unique.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
}

export interface Privacy {
  /** Anything is hidden right now. */
  active: boolean;
  hiddenChannels: ReadonlySet<string>;
  /** Replaces hidden channel and server names in AI-written text; identity while nothing is hidden. */
  redact: (text: string) => string;
}

/** What privacy mode hides right now, for filtering rows built outside SQL. */
export function privacy(db: PluginDb): Privacy {
  const scope = privacyScope(db);
  const names = (table: 'channels' | 'guilds', ids: string[]): string[] =>
    ids.length ? (db.prepare(`SELECT name FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).pluck().all(...ids) as string[]) : [];
  return privacyNames(scope, names('channels', scope.channelIds), names('guilds', scope.guildIds));
}

/** Privacy metadata is read in the same prioritized lane as the served call. */
export async function readPrivacy(read: ArchiveRead): Promise<Privacy> {
  const rows = await read<{ id: string; name: string | null; kind: string }>(`SELECT h.id, c.name, 'channel' AS kind
    FROM hidden_channels h LEFT JOIN channels c ON c.id = h.id
    UNION ALL SELECT h.id, g.name, 'guild' FROM hidden_ids h LEFT JOIN guilds g ON g.id = h.id
    WHERE h.id NOT IN (SELECT id FROM hidden_channels)`);
  const channels = rows.filter((r) => r.kind === 'channel');
  const guilds = rows.filter((r) => r.kind === 'guild');
  const names = (items: typeof rows) => items.flatMap((r) => r.name === null ? [] : [r.name]);
  return privacyNames({ channelIds: channels.map((r) => r.id), guildIds: guilds.map((r) => r.id) }, names(channels), names(guilds));
}

function privacyNames(scope: PrivacyScope, channelNames: string[], guildNames: string[]): Privacy {
  const channels = namesPattern(channelNames);
  const servers = namesPattern(guildNames);
  return {
    active: scope.channelIds.length > 0 || scope.guildIds.length > 0,
    hiddenChannels: new Set(scope.channelIds),
    redact: (text) => {
      const once = channels ? text.replace(channels, REDACTED_CHANNEL) : text;
      return servers ? once.replace(servers, REDACTED_SERVER) : once;
    },
  };
}
