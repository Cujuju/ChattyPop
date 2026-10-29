// Which channels a query covers: a channel includes its threads.
import { THREAD_CHANNEL_TYPES } from '@shared/discord';
import type { RulePlaces } from '@shared/rules';
import { inListSql, listParam } from './idList';

/** Thread channel kinds as an SQL list; the values are numeric constants. */
export const THREAD_KINDS_SQL = [...THREAD_CHANNEL_TYPES].join(', ');

/** SQL true when `column` is one of `channelIds` or a thread of one; bind `params` where the SQL goes. */
export function inChannelsSql(column: string, channelIds: readonly string[]): { sql: string; params: string[] } {
  const list = listParam(channelIds);
  return {
    sql: `(${inListSql(column)} OR ${column} IN (SELECT id FROM channels WHERE kind IN (${THREAD_KINDS_SQL}) AND ${inListSql('parent_id')}))`,
    params: [list, list],
  };
}

/**
 * SQL true when `column` is in a rule's Where: one of its channels (or a thread of one) or a channel of one of its servers.
 * null when both are empty (anywhere). Bind `params` where the SQL goes.
 */
export function inPlacesSql(column: string, { channelIds = [], guildIds = [] }: RulePlaces): { sql: string; params: string[] } | null {
  const parts = [
    ...(channelIds.length ? [inChannelsSql(column, channelIds)] : []),
    ...(guildIds.length
      ? [{ sql: `${column} IN (SELECT id FROM channels WHERE ${inListSql('guild_id')})`, params: [listParam(guildIds)] }]
      : []),
  ];
  return parts.length ? { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) } : null;
}

/**
 * SQL true when message `m` is in the channel bound to `param` (a named parameter, e.g. `@channel`) or in any channel
 * under it. Unlike inChannelsSql, children of every kind count.
 */
export const inChannelOrChildSql = (param: string): string =>
  `(m.channel_id = ${param} OR m.channel_id IN (SELECT id FROM channels WHERE parent_id = ${param}))`;
