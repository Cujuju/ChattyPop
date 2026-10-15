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
    for (const hint of ['MATERIALIZED', 'NOT MATERIALIZED']) {
      expect(sqlViolations(`WITH a AS ${hint} (SELECT id FROM archive_messages), b AS ${hint} (SELECT id FROM a) SELECT * FROM b`, new Set(), false)).toEqual([]);
    }
    expect(sqlViolations('WITH users AS MATERIALIZED (SELECT 1) SELECT * FROM main.users', new Set(), false).length).toBeGreaterThan(0);
    expect(sqlViolations('DELETE FROM archive_all_messages', new Set(), true)).toEqual(['write to archive view: archive_all_messages']);
    expect(tableConstants("const OWN = pluginTable(plugin, 'rows'); const BAD = 'messages';")).toEqual(['OWN']);
  });

  it('checks schema statements: tables, views, indexes and triggers only on its own tables, standalone or among others', () => {
    const fixture = [
      "migrate(['DROP TABLE IF EXISTS messages'])",
      'migrate([`ALTER TABLE "main"."messages" RENAME TO ${OWN}`])',
      'migrate([`ALTER TABLE ${OWN} RENAME TO settings`])',
      "migrate(['create temp table if not exists [channels] (id)'])",
      'migrate([`CREATE TABLE ${OWN} (id); DROP VIEW archive_messages`])',
      'migrate([`INSERT INTO ${OWN} VALUES (1); CREATE INDEX ${OWN}_x ON messages (ts)`])',
      "migrate(['CREATE TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END'])",
      "migrate(['DROP TRIGGER IF EXISTS messages_ai'])",
      "migrate(['DROP INDEX main.messages_ts'])",
      'migrate([`CREATE INDEX ${foreign}_x ON ${OWN} (a)`])',
    ].join('\n');
    const literals = sqlLiterals(fixture);
    expect(literals).toHaveLength(10);
    expect(literals.map(({ sql }) => sqlViolations(sql, new Set(['OWN']), false))).toEqual([
      ['host or unknown table: messages'],
      ['host or unknown table: messages'],
      ['host or unknown table: settings'],
      ['host or unknown table: channels'],
      ['write to archive view: archive_messages'],
      ['host or unknown table: messages'],
      ['host or unknown trigger: t', 'host or unknown table: users'],
      ['host or unknown trigger: messages_ai'],
      ['host or unknown index: messages_ts'],
      ['unowned index expression: foreign'],
    ]);
    const owned = [
      'migrate([`CREATE TABLE IF NOT EXISTS ${OWN} (id TEXT, ts INTEGER); CREATE INDEX IF NOT EXISTS ${OWN}_ts ON ${OWN} (ts)`])',
      'migrate([`ALTER TABLE ${OWN} ADD COLUMN pick TEXT; ALTER TABLE ${OWN} RENAME COLUMN pick TO chosen`])',
      'migrate([`DROP INDEX IF EXISTS ${OWN}_ts; DROP TABLE ${OWN}; ALTER TABLE ${OLD} RENAME TO ${OWN}`])',
      'migrate([`CREATE TRIGGER ${OWN}_ai AFTER INSERT ON ${OWN} BEGIN UPDATE ${OWN} SET ts = 1; END`])',
      'migrate([`CREATE VIEW ${OWN}_recent AS SELECT * FROM ${OWN} JOIN archive_messages m ON 1`])',
      "migrate(['DROP INDEX IF EXISTS legacy_rows_message'])",
    ].join('\n');
    expect(sqlLiterals(owned).map(({ sql }) => sqlViolations(sql, new Set(['OWN', 'OLD']), false, new Set(), ['legacy_rows']))).toEqual([[], [], [], [], [], []]);
    // UI text that merely starts with a schema verb isn't SQL.
    expect(sqlLiterals("label('Create a table of results'); hint('Drop it here'); 'Alter the tables'")).toEqual([]);
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
