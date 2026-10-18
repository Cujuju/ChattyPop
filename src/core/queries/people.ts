// People by name, for pickers (a rule's Who): display name, username, and server nicknames outside hidden servers.
import type { PersonMatch } from '@shared/contract';
import type { Db } from '../db';
import { plainNameSql } from './names';

const COLUMNS = `u.id, ${plainNameSql('u.id')} AS name, u.username, u.avatar`;
/** The LIKE escape character; a typed name's wildcards and this character itself are matched literally. */
const LIKE_ESCAPE = '!';
const LIKE_SPECIAL = /[!%_]/g;

/** Names or usernames starting with the query first, then by name: ranked before the limit, so a short query keeps its best matches. */
export function findPeople(db: Db, query: string, limit: number): PersonMatch[] {
  const q = query.trim();
  if (!q) return [];
  const escaped = q.replace(LIKE_SPECIAL, (c) => `${LIKE_ESCAPE}${c}`);
  const matches = `LIKE @like ESCAPE '${LIKE_ESCAPE}'`;
  const starts = `LIKE @prefix ESCAPE '${LIKE_ESCAPE}'`;
  // One pass over users and one over nicknames: members has no user_id index, so a per-user nickname lookup scans it per user.
  return db
    .prepare(
      `WITH found(id) AS (
         SELECT id FROM users WHERE username ${matches} OR global_name ${matches}
         UNION SELECT user_id FROM members WHERE nick ${matches} AND guild_id NOT IN (SELECT id FROM hidden_ids)
       )
       SELECT ${COLUMNS} FROM found JOIN users u ON u.id = found.id
       ORDER BY (name ${starts} OR u.username ${starts}) DESC, name COLLATE NOCASE LIMIT @limit`,
    )
    .all({ like: `%${escaped}%`, prefix: `${escaped}%`, limit }) as PersonMatch[];
}

export function peopleByIds(db: Db, ids: string[]): PersonMatch[] {
  if (!ids.length) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as PersonMatch[];
}
