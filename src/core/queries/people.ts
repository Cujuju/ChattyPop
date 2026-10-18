// People by name, for pickers (a rule's Who, search's from:): display name, username, and server nicknames outside hidden servers.
import type { PersonMatch } from '@shared/contract';
import type { Db } from '../db';
import { plainNameSql } from './names';
import { visibleChannelSql } from './privacy';
import { placeSql } from './search';

const COLUMNS = `u.id, ${plainNameSql('u.id')} AS name, u.username, u.avatar`;
/** The LIKE escape character; a typed name's wildcards and this character itself are matched literally. */
const LIKE_ESCAPE = '!';
const LIKE_SPECIAL = /[!%_]/g;
const MATCHES = `LIKE @like ESCAPE '${LIKE_ESCAPE}'`;
const STARTS = `LIKE @prefix ESCAPE '${LIKE_ESCAPE}'`;

/**
 * Ids of people whose username, display name or a nickname outside hidden servers contains @like. One pass over users and
 * one over nicknames: members has no user_id index, so a per-user nickname lookup scans it per user.
 */
const NAMED_IDS = `SELECT id FROM users WHERE username ${MATCHES} OR global_name ${MATCHES}
  UNION SELECT user_id FROM members WHERE nick ${MATCHES} AND guild_id NOT IN (SELECT id FROM hidden_ids)`;
/** A name or username starting with the typed name, ranked first. */
const PREFIX_FIRST = `(name ${STARTS} OR u.username ${STARTS}) DESC`;

const likeParams = (name: string) => {
  const escaped = name.replace(LIKE_SPECIAL, (c) => `${LIKE_ESCAPE}${c}`);
  return { like: `%${escaped}%`, prefix: `${escaped}%` };
};

/** Names or usernames starting with the query first, then by name: ranked before the limit, so a short query keeps its best matches. */
export function findPeople(db: Db, query: string, limit: number): PersonMatch[] {
  const q = query.trim();
  if (!q) return [];
  return db
    .prepare(`WITH found(id) AS (${NAMED_IDS}) SELECT ${COLUMNS} FROM found JOIN users u ON u.id = found.id ORDER BY ${PREFIX_FIRST}, name COLLATE NOCASE LIMIT @limit`)
    .all({ ...likeParams(q), limit }) as PersonMatch[];
}

/**
 * People a `from:` in `query` can find: those who posted in the visible channels its `in:` and `server:` terms leave
 * (every visible channel without them), matching `name` (all when empty). A name starting with it first, then those
 * who posted in the shown channel's server, then the most messages there.
 */
export function findSearchAuthors(db: Db, name: string, query: string, shownChannelId: string | null, limit: number): PersonMatch[] {
  const q = name.trim();
  const place = placeSql(query);
  const sql = `WITH posted AS (
      SELECT ca.author_id, SUM(ca.messages) AS messages,
             IFNULL(MAX(c.guild_id = (SELECT guild_id FROM channels WHERE id = @shown)), 0) AS here
      FROM channel_authors ca JOIN channels c ON c.id = ca.channel_id
      WHERE ${[visibleChannelSql('c.id'), ...place.where].join(' AND ')}
      GROUP BY ca.author_id)
    SELECT ${COLUMNS} FROM posted p JOIN users u ON u.id = p.author_id
    ${q ? `WHERE p.author_id IN (${NAMED_IDS})` : ''}
    ORDER BY ${q ? `${PREFIX_FIRST}, ` : ''}p.here DESC, p.messages DESC, name COLLATE NOCASE LIMIT @limit`;
  return db.prepare(sql).all(...place.params, { ...(q ? likeParams(q) : {}), shown: shownChannelId, limit }) as PersonMatch[];
}

export function peopleByIds(db: Db, ids: string[]): PersonMatch[] {
  if (!ids.length) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as PersonMatch[];
}
