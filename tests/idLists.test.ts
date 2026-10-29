// Id-list reads bind the list as one value: any length a remote or phone caller sends reads, never a SQLite error.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARRIVAL } from '../src/core/arrival';
import { messagesByIds } from '../src/core/queries/messages';
import { peopleByIds } from '../src/core/queries/people';
import { rawMessage, seedArchive, tempDb } from './helpers';

/** One past SQLite's default SQLITE_MAX_VARIABLE_NUMBER (32766 since 3.32): a list bound one variable per id fails. */
const PAST_VARIABLE_LIMIT = 32_767;
const CH = '200000000000000001';

describe('id-list reads', () => {
  it('read lists longer than SQLite binds variables for', () => {
    const db = tempDb();
    seedArchive(db, [{ id: CH }]).ingestMessages([rawMessage(CH, 1, 'seed')], ARRIVAL.gateway);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, channel_id, author_id, ts, content) SELECT 'm' || i, ?, 'u' || i, i, 'hello' FROM n`).run(PAST_VARIABLE_LIMIT, CH);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT OR IGNORE INTO users (id, username) SELECT 'u' || i, 'user' || i FROM n`).run(PAST_VARIABLE_LIMIT);
    const ids = (prefix: string) => Array.from({ length: PAST_VARIABLE_LIMIT }, (_, i) => `${prefix}${i + 1}`);
    expect(messagesByIds(db, ids('m'))).toHaveLength(PAST_VARIABLE_LIMIT);
    expect(peopleByIds(db, ids('u'))).toHaveLength(PAST_VARIABLE_LIMIT);
  });

  it('never bind one variable per list item in core', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
    const perItem = /\.map\(\(\) => '\?'\)/;
    expect(files(join(__dirname, '../src/core')).filter((f) => perItem.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
