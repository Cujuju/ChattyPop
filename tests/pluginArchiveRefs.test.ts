// Declared plugin references retain host privacy semantics through migration and bare SQLite reads.
import { ProviderRegistry } from '../src/core/ai/registry';
import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import { definePlugin, pluginTable, visibleTable, type PluginDescriptor } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type CorePlugin } from '@plugin-sdk/core';
import { DEFAULT_AI_SETTINGS } from '@shared/settings';
import { Archive } from '../src/core/archive';
import { getSetting, setSetting, type Db } from '../src/core/db';
import { pluginSettingKey } from '../src/shared/bundledTypes';
import { checkArchiveRefs } from '../src/shared/archiveRefs';
import { createArchiveRefViews, migrateArchiveRefs } from '../src/core/plugins/archiveRefs';
import { PluginHost } from '../src/core/plugins/host';
import { RuleKinds } from '../src/core/rules/kinds';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb, tempDir } from './helpers';

const plugin = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  archiveRefs: { rows: { channel: 'channel_id', message: 'message_id' }, scopes: { channels: 'channel_ids' }, channels: { channel: 'channel_id' } },
});
const ROWS = pluginTable(plugin, 'rows');
const SCOPES = pluginTable(plugin, 'scopes');
const CHANNELS = pluginTable(plugin, 'channels');
const VISIBLE_ROWS = visibleTable(plugin, 'rows');
const VISIBLE_SCOPES = visibleTable(plugin, 'scopes');
const VISIBLE_CHANNELS = visibleTable(plugin, 'channels');
const INITIAL = `CREATE TABLE ${ROWS} (id TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT);
  CREATE TABLE ${SCOPES} (id TEXT PRIMARY KEY, channel_ids TEXT NOT NULL);
  CREATE TABLE ${CHANNELS} (id TEXT PRIMARY KEY, channel_id TEXT)`;
let db: Db;
beforeEach(() => {
  db = tempDb();
  seedArchiveViews(db);
  migrateArchiveRefs(db, plugin, [INITIAL]);
});
const ids = (view: string): string[] => db.prepare(`SELECT id FROM ${view} ORDER BY id`).pluck().all() as string[];
const hostFor = (core: CorePlugin): PluginHost => new PluginHost(tempDir(), {
  db,
  emit: () => undefined,
  changed: () => undefined,
  ai: async () => ({ text: '' }),
  decider: () => null,
  bundled: {
    rules: new RuleKinds(),
    ready: () => db,
    archive: () => new Archive(db),
    mediaDir: tempDir(),
    attachmentsDir: tempDir(),
    pluginData: { root: tempDir(), unmoved: {} },
    storeText: () => undefined,
    storeLinkText: () => undefined, storeLinkImages: () => undefined,
    catchUp: () => undefined,
    saveSetting: (key, value) => setSetting(db, key, value),
    aiSettings: () => DEFAULT_AI_SETTINGS,
    providers: new ProviderRegistry(() => undefined),
    decider: () => null,
    now: Date.now,
  },
}, [core]);

describe('plugin archive reference views', () => {
  it('filters one-message rows, retaining orphans and the reference channel semantics', () => {
    db.exec(`INSERT INTO ${ROWS} SELECT id, channel_id, id FROM messages;
      INSERT INTO ${ROWS} VALUES ('orphan', 'c-open', 'gone'), ('unknown', 'c-missing', 'gone'),
        ('hidden-orphan', 'c-hide', 'gone'), ('null-message', 'c-open', NULL),
        ('different-channel', 'c-open', 'm-hide');
      INSERT INTO ${CHANNELS} SELECT id, id FROM channels`);
    const all = ids(ROWS);
    const statement = db.prepare(`SELECT id FROM ${VISIBLE_ROWS} ORDER BY id`).pluck();
    for (const mode of [true, false, true]) {
      setSetting(db, 'privacyMode', mode);
      expect(statement.all()).toEqual(mode
        ? ['different-channel', 'm-missing', 'm-open', 'null-message', 'orphan', 'unknown'] : all);
      expect(ids(VISIBLE_CHANNELS)).toEqual(mode ? ['c-open'] : ids(CHANNELS));
    }
  });

  it('keeps empty, unknown and mixed channel lists; hides only fully hidden lists', () => {
    const lists = { empty: [], unknown: ['c-missing'], open: ['c-open'], mixed: ['c-hide', 'c-open'], hidden: ['c-hide', 'c-secret'], inherited: ['c-thread'], server: ['c-secret'] };
    const put = db.prepare(`INSERT INTO ${SCOPES} VALUES (?, ?)`);
    for (const [id, channels] of Object.entries(lists)) put.run(id, JSON.stringify(channels));
    for (const mode of [false, true, false]) {
      setSetting(db, 'privacyMode', mode);
      expect(ids(VISIBLE_SCOPES)).toEqual(mode ? ['empty', 'mixed', 'open', 'unknown'] : Object.keys(lists).sort());
    }
  });

  it('exposes all owned columns read-only, including on a bare reopened connection', () => {
    const bare = new Database(db.name);
    try {
      for (const [view, columns] of [[VISIBLE_ROWS, ['id', 'channel_id', 'message_id']], [VISIBLE_SCOPES, ['id', 'channel_ids']], [VISIBLE_CHANNELS, ['id', 'channel_id']]] as const) {
        expect(bare.prepare(`SELECT ${columns.join(', ')} FROM ${view}`).columns().map((c) => c.name)).toEqual([...columns]);
        expect(() => bare.prepare(`SELECT * FROM ${view}`).all()).not.toThrow();
        expect(() => bare.exec(`INSERT INTO ${view} (id) VALUES ('new')`)).toThrow(/view/i);
        expect(() => bare.exec(`UPDATE ${view} SET id = 'new'`)).toThrow(/view/i);
        expect(() => bare.exec(`DELETE FROM ${view}`)).toThrow(/view/i);
      }
      bare.exec('CREATE TABLE legacy_probe (id TEXT); ALTER TABLE legacy_probe RENAME TO adopted_probe');
    } finally {
      bare.close();
    }
  });

  it('rebuilds views for replacement schemas, remains idempotent and rolls failed migrations back', () => {
    db.exec(`INSERT INTO ${ROWS} VALUES ('kept', 'c-open', 'm-open')`);
    const replace = `ALTER TABLE ${ROWS} RENAME TO old_probe_rows;
      CREATE TABLE ${ROWS} (id TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT, detail TEXT DEFAULT 'added');
      INSERT INTO ${ROWS} (id, channel_id, message_id) SELECT * FROM old_probe_rows;
      DROP TABLE old_probe_rows`;
    migrateArchiveRefs(db, plugin, [INITIAL, replace]);
    migrateArchiveRefs(db, plugin, [INITIAL, replace]);
    expect(db.prepare(`SELECT * FROM ${VISIBLE_ROWS}`).all()).toEqual([{ id: 'kept', channel_id: 'c-open', message_id: 'm-open', detail: 'added' }]);
    expect(() => migrateArchiveRefs(db, plugin, [INITIAL, replace, `ALTER TABLE ${ROWS} DROP COLUMN message_id`])).toThrow(/missing table or declared column/);
    expect(getSetting(db, pluginSettingKey('probe', '$schemaVersion'))).toBe(2);
    expect(ids(VISIBLE_ROWS)).toEqual(['kept']);
    expect(db.prepare(`SELECT message_id FROM ${VISIBLE_ROWS}`).pluck().get()).toBe('m-open');
  });

  it('requires declared tables and safe, unambiguous column shapes', () => {
    expect(() => visibleTable(plugin, 'undeclared')).toThrow(/no archive reference/);
    for (const ref of [{}, { channel: 'channel_id', channels: 'channel_ids' }, { channel: 'x); DROP TABLE messages' }, { channels: 'channel_ids', message: 'message_id' }]) {
      const invalid = { ...plugin, archiveRefs: { rows: ref } } as PluginDescriptor;
      expect(() => checkArchiveRefs(invalid)).toThrow(/archive reference/);
    }
    const missing = { ...plugin, archiveRefs: { absent: { channel: 'channel_id' } } };
    expect(() => createArchiveRefViews(db, missing, false)).not.toThrow();
    expect(() => createArchiveRefViews(db, missing)).toThrow(/missing table or declared column/);
  });

  it('creates views through context migrations before activation reads, refreshes on reload and guards held payload readers', async () => {
    const owner = definePlugin({ ...plugin, manifest: { ...plugin.manifest, id: 'lifecycle' }, archiveRefs: { rows: { channel: 'channel_id' } } });
    const table = pluginTable(owner, 'rows');
    const view = visibleTable(owner, 'rows');
    let context!: CoreContext<typeof owner>;
    const steps = [`CREATE TABLE ${table} (id TEXT, channel_id TEXT); INSERT INTO ${table} VALUES ('kept', 'c-open')`];
    const host = hostFor(defineCorePlugin(owner, (ctx) => {
      context = ctx;
      ctx.storage.migrate(steps);
      expect(ids(view)).toEqual(['kept']);
    }));
    host.startBundled();
    expect(host.list()[0]?.status).toBe('active');
    const held = context.archive.payloads;
    expect([...held(['m-open']).keys()]).toEqual(['m-open']);
    await host.setEnabled('lifecycle', false);
    expect([...held(['m-open']).keys()]).toEqual([]);
    steps.push(`ALTER TABLE ${table} ADD COLUMN detail TEXT DEFAULT 'new'`);
    await host.setEnabled('lifecycle', true);
    expect(host.list()[0]?.status).toBe('active');
    expect(db.prepare(`SELECT detail FROM ${view}`).pluck().get()).toBe('new');
    await host.setEnabled('lifecycle', false);
  });

  it('rejects activation when a declared archive table was never created', () => {
    const owner = definePlugin({ ...plugin, archiveRefs: { absent: { channel: 'channel_id' } } });
    const host = hostFor(defineCorePlugin(owner, () => undefined));
    host.startBundled();
    expect(host.list()[0]?.status).toBe('error');
    expect(host.list()[0]?.error).toBe('probe archive reference absent: missing table or declared column');
  });
});
