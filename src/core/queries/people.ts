// People by name, for pickers (a rule's Who): display name, username, and server nicknames outside hidden servers.
import type { PersonMatch } from '@shared/contract';
import type { Db } from '../db';
import { plainNameSql } from './names';

const COLUMNS = `u.id, ${plainNameSql('u.id')} AS name, u.username, u.avatar`;
/** The LIKE escape character; a typed name's wildcards and this character itself are matched literally. */
const LIKE_ESCAPE = '!';
const LIKE_SPECIAL = /[!%_]/g;

export function findPeople(db: Db, query: string, limit: number): PersonMatch[] {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replace(LIKE_SPECIAL, (c) => `${LIKE_ESCAPE}${c}`)}%`;
  const matches = `LIKE @like ESCAPE '${LIKE_ESCAPE}'`;
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM users u
       WHERE u.username ${matches} OR u.global_name ${matches}
          OR EXISTS (SELECT 1 FROM members mem WHERE mem.user_id = u.id AND mem.nick ${matches} AND mem.guild_id NOT IN (SELECT id FROM hidden_ids))
       ORDER BY name COLLATE NOCASE LIMIT @limit`,
    )
    .all({ like, limit }) as PersonMatch[];
}

export function peopleByIds(db: Db, ids: string[]): PersonMatch[] {
  if (!ids.length) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM users u WHERE u.id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as PersonMatch[];
}
