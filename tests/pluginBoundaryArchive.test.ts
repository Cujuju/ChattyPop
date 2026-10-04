// The plugin SQL boundary scanner (plugin:check's scan, scripts/pluginScan): plugins read archive contracts and write
// only their own namespaced tables.
import { describe, expect, it } from 'vitest';
import { privacyViolations, sqlLiterals, sqlViolations, tableConstants } from '../scripts/pluginScan/sql';

describe('plugin archive boundary', () => {
  it('rejects planted violations in strings and templates, including disguised targets', () => {
    const fixture = [
      "db.prepare('SELECT * FROM messages')",
      'db.prepare(`SELECT * FROM archive_messages JOIN channels c ON 1`)',
      'db.prepare(`INSERT INTO archive_messages VALUES (1)`)',
      'db.prepare(`UPDATE archive_all_channels SET name = 1`)',
      'db.prepare(`DELETE FROM archive_users`)',
      'db.prepare(`SELECT * FROM archive_all_messages`)',
      'db.prepare(`SELECT * FROM ${foreign}`)',
      'db.prepare(`SELECT * FROM "main"."messages"`)',
      'db.prepare(`SELECT * FROM archive_messages m, users u`)',
      'db.prepare(`REPLACE INTO settings VALUES (1)`)',
      "db.prepare('SELECT * FROM ' + 'messages')",
      'db.prepare(`select * from /* probe */ [messages]`)',
      'db.prepare(`SELECT * FROM ${select} JOIN users u ON 1`)',
      "db.prepare('SELECT*FROM messages')",
      "db.prepare('WITH users AS (SELECT * FROM main.users) SELECT * FROM users')",
    ].join('\n');
    const literals = sqlLiterals(fixture);
    expect(literals).toHaveLength(15);
    for (const { sql } of literals) expect(sqlViolations(sql, new Set(), false).length).toBeGreaterThan(0);
  });

  it('accepts owned constants, CTEs, subqueries and json_each; never exempts archive writes', () => {
    const fixture = 'db.prepare(`WITH picked AS (SELECT id FROM archive_messages) SELECT * FROM picked JOIN (SELECT value FROM json_each(\'[]\')) j ON 1; UPDATE ${OWN} SET value = 1`)';
    expect(sqlViolations(sqlLiterals(fixture)[0]!.sql, new Set(['OWN']), false)).toEqual([]);
    expect(sqlViolations('DELETE FROM archive_all_messages', new Set(), true)).toEqual(['write to archive view: archive_all_messages']);
    expect(tableConstants("const OWN = pluginTable(plugin, 'rows'); const BAD = 'messages';")).toEqual(['OWN']);
  });

  it('rejects plugin privacy predicates and writes to declared visibility views', () => {
    for (const name of ['privacy_visible', 'reference_visible', 'hidden_channels', 'hidden_ids']) {
      expect(privacyViolations(`db.prepare('SELECT ${name} FROM archive_messages')`)).toEqual([name]);
    }
    const views = new Set(tableConstants("const VISIBLE = visibleTable(plugin, 'rows');", true));
    expect([...views]).toEqual(['VISIBLE']);
    for (const operation of ['UPDATE ${VISIBLE} SET read_at = 1', 'INSERT INTO ${VISIBLE} VALUES (1)', 'DELETE FROM ${VISIBLE}']) {
      const sql = sqlLiterals('db.prepare(`' + operation + '`)')[0]!.sql;
      expect(sqlViolations(sql, new Set(), true, views)).toEqual(['write to visible view: VISIBLE']);
    }
    const read = sqlLiterals('db.prepare(`SELECT * FROM ${VISIBLE}`)')[0]!.sql;
    expect(sqlViolations(read, new Set(), false, views)).toEqual([]);
  });
});
