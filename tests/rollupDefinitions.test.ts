import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDb } from './helpers';
import { reconcileDefinition } from '../src/core/rollups/definitions';
import { installRollupStore, rollupTable } from '../src/core/rollups/store';
import { installRollupTriggers } from '../src/core/rollups/triggers';
import { installRollupReferences } from '../src/core/rollups/privacy';

describe('persistent generated rollup definitions', () => {
  it.each(['insert', 'update', 'delete'])('repairs hidden-id %s visibility triggers changed by another version', (operation) => {
    const db = tempDb(); onTestFinished(() => { db.close(); }); installRollupStore(db);
    const name = `rollup_visibility_hidden_ids_${operation}`;
    db.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} AFTER ${operation} ON hidden_ids BEGIN SELECT 1; END;`);
    installRollupStore(db);
    db.exec("INSERT INTO hidden_ids(id, kind) VALUES ('first', 'channel')");
    const before = db.prepare('SELECT revision FROM rollup_visibility_state').pluck().get() as number;
    if (operation === 'insert') db.exec("INSERT INTO hidden_ids(id, kind) VALUES ('second', 'channel')");
    else if (operation === 'update') db.exec("UPDATE hidden_ids SET id = 'second' WHERE id = 'first'");
    else db.exec("DELETE FROM hidden_ids WHERE id = 'first'");
    expect(db.prepare('SELECT revision FROM rollup_visibility_state').pluck().get()).toBe(before + 1);
  });

  it('replaces old message-reference and attachment-column triggers without changing data tables', () => {
    const db = tempDb(); onTestFinished(() => { db.close(); });
    installRollupStore(db); installRollupTriggers(db);
    reconcileDefinition(db, 'rollup_reference_messages/triggers', `CREATE TRIGGER rollup_reference_messages_insert AFTER INSERT ON messages BEGIN SELECT 1; END;`);
    installRollupReferences(db);
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'rollup_reference_messages_insert'").pluck().get()).toContain('rollup_reference_pending');
    db.exec('DROP TRIGGER rollup_reference_messages_insert; CREATE TRIGGER rollup_reference_messages_insert AFTER INSERT ON messages BEGIN SELECT 1; END;');
    installRollupReferences(db);
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'rollup_reference_messages_insert'").pluck().get()).toContain('rollup_reference_pending');
    db.exec('ALTER TABLE attachments ADD COLUMN fixture_revision INTEGER');
    installRollupTriggers(db);
    db.exec("INSERT INTO rollup_meta(rollup, version, zone) VALUES ('probe.files', 1, 'UTC'); INSERT INTO rollup_kinds VALUES ('probe.files', 'attachments')");
    db.exec("INSERT INTO attachments(id, message_id, channel_id, filename, url, ts) VALUES ('file', 'message', 'channel', 'file', 'https://example.test', 0); DELETE FROM rollup_dirty");
    db.exec("UPDATE attachments SET fixture_revision = 1 WHERE id = 'file'");
    expect(db.prepare('SELECT channel_id FROM rollup_dirty').pluck().all()).toEqual(['channel']);
    expect(db.prepare("SELECT fixture_revision FROM attachments WHERE id = 'file'").pluck().get()).toBe(1);
  });

  it('reconciles daily and all-time privacy views on an existing database', () => {
    const db = tempDb(); onTestFinished(() => { db.close(); }); installRollupStore(db);
    const spec = { version: 1, columns: { key: 'TEXT' as const, n: 'INTEGER' as const }, key: ['key'], dependsOn: ['messages' as const],
      compute: async () => [], allTime: { values: { n: 'sum' as const } } };
    const table = rollupTable(db, 'probe', 'counts', spec);
    for (const [key, view] of [[`${table}/visible`, `${table}_visible`], [`${table}/all-time-visible`, `${table}_all_time_visible`]]) {
      reconcileDefinition(db, key!, `CREATE VIEW "${view}" AS SELECT * FROM "${table}" WHERE 0`);
    }
    rollupTable(db, 'probe', 'counts', spec);
    for (const view of [`${table}_visible`, `${table}_all_time_visible`]) {
      expect(db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').pluck().get(view)).toContain('hidden_channels');
    }
    expect(db.prepare('SELECT COUNT(*) FROM pragma_table_info(?)').pluck().get(table)).toBe(4);
  });

  it('rolls back failed DDL and retains the previous definition', () => {
    const db = tempDb(); onTestFinished(() => { db.close(); });
    reconcileDefinition(db, 'probe', 'CREATE VIEW rollup_fixture AS SELECT 1 AS n');
    expect(() => reconcileDefinition(db, 'probe', 'CREATE VIEW rollup_fixture AS invalid SQL')).toThrow();
    expect(db.prepare('SELECT n FROM rollup_fixture').pluck().get()).toBe(1);
  });
});
