// Persistent archive contracts preserve privacy, text, names, search rank and read-only access.
import { archivePayloads } from '../src/core/plugins/archivePayloads';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { compressRawJson, setSetting, type Db } from '../src/core/db';
import { definePlugin } from '@plugin-sdk/shared';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { probe as ruleProbe } from './pluginRuleDescriptor';
import { noHiddenRefSql, visibleChannelSql, visibleMessageRefSql, visibleMessageSql } from '../src/core/queries/privacy';
import { tempDb } from './helpers';
import { seedArchiveViews, VIEW_COLUMNS, archiveViewNames } from './archiveViewsFixture';

/** Adopts the legacy built-in transcription queue table. */
const tableAdopter = definePlugin({
  manifest: { id: 'adopter', name: 'Adopter', version: '1', description: '' },
  adopts: { tables: { transcripts: 'jobs' } },
});
/** A legacy built-in action kind, renamed to an action the rule probe declares. */
const LEGACY_ACTION_KIND = 'builtInAct';
const actionAdopter = { ...ruleProbe, adopts: { actionKinds: { [LEGACY_ACTION_KIND]: 'ruleprobe.instant' } } };

let db: Db;
beforeEach(() => {
  db = tempDb();
  seedArchiveViews(db);
});
const ids = (sql: string): unknown[] => db.prepare(sql).pluck().all();
const count = (view: string): number => db.prepare(`SELECT COUNT(*) FROM ${view}`).pluck().get() as number;

describe('archive views', () => {
  it('reads every persistent view and adopts tables on a reopened connection without application functions', () => {
    db.prepare("UPDATE messages SET raw_json = ? WHERE id = 'm-open'").run(compressRawJson('{"flags":8192}'));
    const documented = Object.keys(VIEW_COLUMNS).flatMap(archiveViewNames).sort();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'view' AND name GLOB 'archive_*' ORDER BY name").pluck().all()).toEqual(documented);
    const bare = new Database(db.name);
    try {
      for (const [name, columns] of Object.entries(VIEW_COLUMNS)) {
        for (const view of archiveViewNames(name)) {
          expect(() => bare.prepare(`SELECT ${columns} FROM ${view}`).all()).not.toThrow();
        }
      }
      expect(() => adoptBundledData(bare, [tableAdopter])).not.toThrow();
      expect(bare.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('transcripts', 'p_adopter_jobs')").pluck().all()).toEqual(['p_adopter_jobs']);
      expect(archivePayloads(bare, ['m-open']).get('m-open')?.flags).toBe(8192);
    } finally {
      bare.close();
    }
  });

  it('adopts legacy action identities even when they were inserted after host migration', () => {
    db.exec(`INSERT INTO rule_runs (id, rule_id, event_key, live, at) VALUES (1, 1, 'old', 1, 2);
      INSERT INTO rule_action_runs (run_id, action_id, kind, outcome, detail, at) VALUES (1, 'post', '${LEGACY_ACTION_KIND}', 'done', 'kept', 3)`);
    adoptBundledData(db, [actionAdopter]);
    adoptBundledData(db, [actionAdopter]);
    expect(db.prepare('SELECT * FROM rule_action_runs').all()).toEqual([
      { run_id: 1, action_id: 'post', kind: 'ruleprobe.instant', outcome: 'done', detail: 'kept', at: 3, sat_out: 0 },
    ]);
  });

  it('selects every documented column in both contracts and rejects every kind of write', () => {
    for (const [name, columns] of Object.entries(VIEW_COLUMNS)) {
      for (const view of archiveViewNames(name)) {
        const statement = db.prepare(`SELECT ${columns} FROM ${view}`);
        expect(statement.columns().map((column) => column.name)).toEqual(columns.split(', '));
        expect(() => statement.all()).not.toThrow();
        const first = columns.split(', ')[0]!;
        expect(() => db.prepare(`INSERT INTO ${view} (${first}) VALUES (NULL)`).run()).toThrow(/view/i);
        expect(() => db.prepare(`UPDATE ${view} SET ${first} = ${first}`).run()).toThrow(/view/i);
        expect(() => db.prepare(`DELETE FROM ${view}`).run()).toThrow(/view/i);
      }
    }
  });

  it('matches host privacy predicates exactly, including orphan references and inherited privacy', () => {
    const expected: Record<string, string> = {
      messages: `SELECT m.id FROM messages m WHERE ${visibleMessageSql('m')}`,
      channels: `SELECT id FROM channels WHERE ${visibleChannelSql('id')}`,
      guilds: 'SELECT id FROM guilds WHERE id NOT IN (SELECT id FROM hidden_ids)',
      users: 'SELECT id FROM users',
      attachments: `SELECT a.id FROM attachments a WHERE ${visibleMessageRefSql('a.channel_id', 'a.message_id')}`,
      rules: 'SELECT id FROM rules',
      links: `SELECT l.id FROM links l WHERE ${visibleMessageRefSql('l.first_channel_id', 'l.first_message_id')} AND ${noHiddenRefSql('l.url')}`,
    };
    for (const mode of [false, true, false]) {
      setSetting(db, 'privacyMode', mode);
      for (const [name, query] of Object.entries(expected)) {
        expect(ids(`SELECT id FROM archive_${name} ORDER BY id`)).toEqual(ids(`${query} ORDER BY id`));
      }
      expect(ids('SELECT message_id FROM archive_message_links ORDER BY message_id, link_id')).toEqual(ids(
        `SELECT ml.message_id FROM message_links ml LEFT JOIN messages m ON m.id = ml.message_id WHERE m.id IS NULL OR ${visibleMessageSql('m')} ORDER BY ml.message_id, ml.link_id`,
      ));
      expect(ids('SELECT seq FROM archive_search ORDER BY seq')).toEqual(ids(`SELECT m.seq FROM messages m WHERE ${visibleMessageSql('m')} ORDER BY m.seq`));
      expect(ids('SELECT channel_id FROM archive_names ORDER BY channel_id')).toEqual(ids(
        `SELECT c.id FROM members mem JOIN channels c ON c.guild_id = mem.guild_id WHERE ${visibleChannelSql('c.id')} ORDER BY c.id`,
      ));
      if (mode) {
        expect(ids('SELECT id FROM archive_messages ORDER BY id')).toEqual(['m-missing', 'm-open']);
        expect(ids('SELECT id FROM archive_attachments ORDER BY id')).toEqual(['a-orphan', 'm-missing', 'm-open']);
      }
    }
  });

  it('keeps all rows in every all-data view, with matching columns and no stale privacy snapshot', () => {
    const counts: Record<string, number> = { messages: 7, channels: 4, guilds: 2, users: 2, attachments: 9, rules: 1, links: 5, message_links: 5, search: 7, names: 4 };
    const visible = db.prepare('SELECT id FROM archive_messages ORDER BY id');
    for (const mode of [false, true, false]) {
      setSetting(db, 'privacyMode', mode);
      for (const [name, total] of Object.entries(counts)) {
        expect(count(archiveViewNames(name).at(-1)!)).toBe(total);
        if (!mode) expect(count(`archive_${name}`)).toBe(total);
      }
      expect(visible.all()).toHaveLength(mode ? 2 : 7);
    }
  });

  it('preserves ordered derived text, linked text, nicknames, missing authors and compressed payload fields', () => {
    const raw = { flags: 8192, type: 19, author: { bot: true }, embeds: [{ title: 'Card' }], mentions: [{ id: 'u2' }], message_reference: { message_id: 'reply' } };
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(compressRawJson(JSON.stringify(raw)), 'm-open');
    expect(db.prepare(`SELECT text, linked, author_name, author_plain_name
      FROM archive_messages WHERE id = 'm-open'`).get()).toEqual({
      text: 'hello open\nfirst\nsecond', linked: 'linked text', author_name: 'Ally', author_plain_name: 'Alice',
    });
    expect(archivePayloads(db, ['m-open']).get('m-open')).toMatchObject({ flags: 8192, isReply: 1, replyToId: 'reply', bot: 1, embedsJson: JSON.stringify(raw.embeds), mentionsJson: JSON.stringify(raw.mentions) });
    expect(db.prepare("SELECT author_name, author_plain_name FROM archive_messages WHERE id = 'm-missing'").get()).toEqual({ author_name: 'u-missing', author_plain_name: 'u-missing' });
    expect(db.prepare("SELECT display_name FROM archive_users WHERE id = 'u2'").pluck().get()).toBe('bob');
  });

  it('keeps FTS MATCH and default bm25 rank through the search views', () => {
    const all = db.prepare('SELECT seq, rank FROM archive_all_search WHERE query MATCH ? ORDER BY rank, seq');
    const host = db.prepare('SELECT rowid AS seq, bm25(fts_messages) AS rank FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rank, seq');
    expect(all.all('hello')).toEqual(host.all('hello'));
    setSetting(db, 'privacyMode', true);
    expect(all.all('hello')).toEqual(host.all('hello'));
    expect(db.prepare('SELECT seq FROM archive_search WHERE query MATCH ? ORDER BY seq').pluck().all('hello')).toEqual(ids('SELECT seq FROM archive_messages ORDER BY seq'));
  });
});
