// Consumer parity for orphan references, unfiltered background values and channel-list scopes.
import { archivePayloads } from '../src/core/plugins/archivePayloads';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSetting, type Db } from '../src/core/db';
import { audioSeconds as hostSeconds } from '../src/core/queries/messageContent';
import { visibleMessageRefSql } from '../src/core/queries/privacy';
import { createArchiveRefViews } from '../src/core/plugins/archiveRefs';
import { definePlugin, pluginTable, visibleTable } from '@plugin-sdk/shared';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb } from './helpers';

let db: Db;
beforeEach(() => {
  db = tempDb();
  seedArchiveViews(db);
});

describe('plugin archive read parity', () => {
  it('preserves orphan message records in a plugin inbox view under both privacy modes', () => {
    const probe = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, archiveRefs: { inbox: { channel: 'channel_id', message: 'message_id' } } });
    const table = pluginTable(probe, 'inbox');
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, channel_id TEXT, message_id TEXT);
      INSERT INTO ${table} (channel_id, message_id) SELECT channel_id, message_id FROM archive_all_attachments`);
    createArchiveRefViews(db, probe);
    for (const mode of [false, true]) {
      setSetting(db, 'privacyMode', mode);
      const expected = db.prepare(`SELECT a.id FROM ${table} a WHERE ${visibleMessageRefSql('a.channel_id', 'a.message_id')} ORDER BY a.id DESC`).pluck().all();
      expect(db.prepare(`SELECT id FROM ${visibleTable(probe, 'inbox')} ORDER BY id DESC`).pluck().all()).toEqual(expected);
      expect(db.prepare(`SELECT message_id FROM ${visibleTable(probe, 'inbox')}`).pluck().all()).toContain('gone');
    }
  });

  it('preserves durations while privacy is on', () => {
    setSetting(db, 'privacyMode', true);
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(JSON.stringify({ attachments: [{ duration_secs: 12 }] }), 'm-hide');
    for (const id of ['m-open', 'm-hide', 'm-missing', 'gone']) {
      expect(archivePayloads(db, [id]).get(id)?.audioSeconds ?? null).toEqual(hostSeconds(db, id));
    }
    expect(archivePayloads(db, ['m-hide']).get('m-hide')?.audioSeconds).toBe(12);
  });

  it('keeps summaries with unknown or visible channels and excludes only fully hidden scopes', () => {
    setSetting(db, 'privacyMode', true);
    const probe = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, archiveRefs: { scopes: { channels: 'channel_ids' } } });
    const table = pluginTable(probe, 'scopes');
    db.exec(`CREATE TABLE ${table} (channel_ids TEXT)`);
    createArchiveRefViews(db, probe);
    const put = db.prepare(`INSERT INTO ${table} VALUES (?)`);
    for (const channels of [[], ['c-missing'], ['c-open'], ['c-hide', 'c-open'], ['c-hide', 'c-secret']]) put.run(JSON.stringify(channels));
    expect(db.prepare(`SELECT COUNT(*) FROM ${visibleTable(probe, 'scopes')}`).pluck().get()).toBe(4);
  });
});
