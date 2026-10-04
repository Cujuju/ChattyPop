// Privacy mode: servers and channels marked private leave every view while it is on. The hidden_ids table (kept current
// by triggers, hiddenScope.ts) and its hidden_channels view hold what is hidden right now; both are empty while it is off.
import type { PrivacyScope } from '@shared/contract';
import type { PluginDb } from '../plugins/pluginDb';

/** SQL true when channel id `column` is not hidden. */
export const visibleChannelSql = (column: string): string => `${column} NOT IN (SELECT id FROM hidden_channels)`;

/** Which of `channelIds` privacy mode leaves visible: an event about a hidden one reaches no view, phone or plugin. */
export const visibleChannelIds = (db: PluginDb, channelIds: string[]): Set<string> =>
  new Set(db.prepare(`SELECT value FROM json_each(?) WHERE ${visibleChannelSql('value')}`).pluck().all(JSON.stringify(channelIds)) as string[]);

/**
 * SQL true while nothing is hidden. Uncorrelated, so SQLite evaluates it once per statement; it guards the per-row id
 * checks, which scan the hidden ids (a few rows) for every row while privacy mode hides something.
 */
export const NOTHING_HIDDEN_SQL = 'NOT EXISTS (SELECT 1 FROM hidden_ids)';

/** SQL true when `text` holds a hidden channel or server id (no guard: callers add NOTHING_HIDDEN_SQL). */
const hiddenRefSql = (text: string): string => `EXISTS (SELECT 1 FROM hidden_ids h WHERE instr(${text}, h.id) > 0)`;

/** SQL true when `text` holds no hidden channel or server id, as a <#id> mention or a discord.com/channels link would. */
export const noHiddenRefSql = (text: string): string => `(${NOTHING_HIDDEN_SQL} OR NOT ${hiddenRefSql(text)})`;

/** SQL true when message alias `m` is in a visible channel and names no hidden one. */
export const visibleMessageSql = (m: string): string => `(${visibleChannelSql(`${m}.channel_id`)} AND ${noHiddenRefSql(`${m}.content`)})`;

/** SQL true when a row about message `idColumn` in channel `channelColumn` is visible: its channel is, and the message (when archived) names no hidden id. */
export const visibleMessageRefSql = (channelColumn: string, idColumn: string): string =>
  `(${visibleChannelSql(channelColumn)} AND (${NOTHING_HIDDEN_SQL} OR NOT EXISTS (SELECT 1 FROM messages hm WHERE hm.id = ${idColumn} AND ${hiddenRefSql('hm.content')})))`;

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
  const channels = namesPattern(names('channels', scope.channelIds));
  const servers = namesPattern(names('guilds', scope.guildIds));
  return {
    active: scope.channelIds.length > 0 || scope.guildIds.length > 0,
    hiddenChannels: new Set(scope.channelIds),
    redact: (text) => {
      const once = channels ? text.replace(channels, REDACTED_CHANNEL) : text;
      return servers ? once.replace(servers, REDACTED_SERVER) : once;
    },
  };
}
