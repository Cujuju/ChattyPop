// The privacy scope kept as a table by triggers: after every write that can change what is hidden, it holds what
// the views it replaced derived (the oracle below, their frozen SQL), including through REPLACE, upserts and renames.
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db';
import { setSetting } from '../src/core/db';
import { Archive } from '../src/core/archive';
import { HIDDEN_SCOPE_RENAMES, HIDDEN_SCOPE_TABLE } from '../src/core/hiddenScope';
import { applyMigrations, migrationIndex, tempDb, tempDir } from './helpers';
import { TEST_ARCHIVE, hideSome, seedPerfArchive } from './perfArchiveFixture';

/** The replaced views, as their migration created them. */
const ORACLE = `
  CREATE TEMP VIEW oracle_channels AS
    SELECT c.id FROM channels c LEFT JOIN channels p ON p.id = c.parent_id LEFT JOIN guilds g ON g.id = c.guild_id
    WHERE (SELECT value FROM settings WHERE key = 'privacyMode') = 'true'
      AND (c.hide_in_privacy = 1 OR p.hide_in_privacy = 1 OR g.hide_in_privacy = 1);
  CREATE TEMP VIEW oracle_ids AS
    SELECT id FROM oracle_channels
    UNION ALL SELECT id FROM guilds WHERE hide_in_privacy = 1 AND (SELECT value FROM settings WHERE key = 'privacyMode') = 'true';`;

const ids = (db: Db, from: string): string[] => db.prepare(`SELECT id FROM ${from} ORDER BY id`).pluck().all() as string[];

/** A migrated archive with the oracle; `check()` asserts the scope matches it and returns how many ids are hidden. */
function scoped(db: Db = tempDb()) {
  db.exec(ORACLE);
  const check = (): number => {
    expect(ids(db, 'hidden_channels')).toEqual(ids(db, 'oracle_channels'));
    expect(ids(db, 'hidden_ids')).toEqual(ids(db, 'oracle_ids'));
    return ids(db, 'hidden_ids').length;
  };
  return { db, check, run: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args) };
}

const guild = 'INSERT INTO guilds (id, name) VALUES (?, ?)';
const channel = 'INSERT INTO channels (id, guild_id, name, kind, parent_id) VALUES (?, ?, ?, 0, ?)';

describe('the hidden scope table', () => {
  it('follows privacy mode however its setting is written, and is empty while it is off', () => {
    const { db, check, run } = scoped();
    run(guild, 'g1', 'G');
    run(channel, 'c1', 'g1', 'c', null);
    run('UPDATE guilds SET hide_in_privacy = 1');
    expect(check()).toBe(0);
    setSetting(db, 'privacyMode', true);
    expect(check()).toBe(2);
    setSetting(db, 'privacyMode', false);
    expect(check()).toBe(0);
    run("INSERT OR REPLACE INTO settings (key, value) VALUES ('privacyMode', 'true')");
    expect(check()).toBe(2);
    run("DELETE FROM settings WHERE key = 'privacyMode'");
    expect(check()).toBe(0);
    run("INSERT INTO settings (key, value) VALUES ('other', 'true')");
    run("UPDATE settings SET key = 'privacyMode' WHERE key = 'other'");
    expect(check()).toBe(2);
    run("UPDATE settings SET key = 'renamed' WHERE key = 'privacyMode'");
    expect(check()).toBe(0);
  });

  it("follows channels: a child before its parent, a parent's flag, moves, renamed ids, REPLACE and deletes", () => {
    const { db, check, run } = scoped();
    setSetting(db, 'privacyMode', true);
    run(guild, 'g1', 'G');
    run(channel, 't1', 'g1', 'thread', 'c1');
    expect(check()).toBe(0);
    run('INSERT INTO channels (id, guild_id, name, kind, parent_id, hide_in_privacy) VALUES (?, ?, ?, 0, NULL, 1)', 'c1', 'g1', 'c');
    expect(check()).toBe(2);
    run(channel, 'c2', 'g1', 'c', null);
    run("UPDATE channels SET parent_id = 'c2' WHERE id = 't1'");
    expect(check()).toBe(1);
    run("UPDATE channels SET parent_id = 'c1' WHERE id = 't1'");
    expect(check()).toBe(2);
    run("UPDATE channels SET id = 'c9' WHERE id = 'c1'");
    expect(check()).toBe(1);
    run("UPDATE channels SET id = 'c1' WHERE id = 'c9'");
    expect(check()).toBe(2);
    run('UPDATE channels SET hide_in_privacy = 0');
    expect(check()).toBe(0);
    run("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'c1'");
    run("INSERT OR REPLACE INTO channels (id, guild_id, name, kind, parent_id) VALUES ('c1', 'g1', 'c', 0, NULL)");
    expect(check()).toBe(0);
    run("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'c1'");
    run("DELETE FROM channels WHERE id = 'c1'");
    expect(check()).toBe(0);
    run("UPDATE channels SET hide_in_privacy = 1 WHERE id = 't1'");
    run("UPDATE channels SET guild_id = NULL WHERE id = 't1'");
    expect(check()).toBe(1);
  });

  it('follows servers: added after their channels, flagged, renamed, replaced and deleted', () => {
    const { db, check, run } = scoped();
    setSetting(db, 'privacyMode', true);
    run(channel, 'c1', 'g1', 'c', null);
    run(channel, 't1', 'g2', 'thread', 'c1');
    run('INSERT INTO guilds (id, name, hide_in_privacy) VALUES (?, ?, 1)', 'g1', 'G');
    expect(check()).toBe(2);
    run("UPDATE channels SET guild_id = 'g1' WHERE id = 't1'");
    expect(check()).toBe(3);
    run("UPDATE guilds SET id = 'g9' WHERE id = 'g1'");
    expect(check()).toBe(1);
    run("UPDATE guilds SET id = 'g1' WHERE id = 'g9'");
    run("INSERT OR REPLACE INTO guilds (id, name) VALUES ('g1', 'G')");
    expect(check()).toBe(0);
    run("UPDATE guilds SET hide_in_privacy = 1 WHERE id = 'g1'");
    expect(check()).toBe(3);
    run("DELETE FROM guilds WHERE id = 'g1'");
    expect(check()).toBe(0);
  });

  it("keeps a server's id listed twice when its default channel shares it and is hidden too, as the views did", () => {
    const { db, check, run } = scoped();
    setSetting(db, 'privacyMode', true);
    run('INSERT INTO guilds (id, name, hide_in_privacy) VALUES (?, ?, 1)', 's1', 'G');
    run(channel, 's1', 's1', 'general', null);
    expect(check()).toBe(2);
  });

  it("follows the archive's own writes: directory and thread upserts, channel and server switches", () => {
    const { db, check } = scoped();
    const archive = new Archive(db);
    /** Snowflake-shaped ids, as the server switch requires. */
    const [g1, g2, c1, c2, t1, c3] = ['100000000000000001', '100000000000000002', '200000000000000001', '200000000000000002', '300000000000000001', '200000000000000003'];
    setSetting(db, 'privacyMode', true);
    archive.upsertGuilds([{ id: g1, name: 'G' }, { id: g2, name: 'H' }]);
    archive.upsertChannels(g1, [{ id: c1, name: 'a', type: 0 }, { id: c2, name: 'b', type: 0 }]);
    archive.setOptIn(c1, true);
    archive.upsertThreads([{ id: t1, name: 't', type: 11, parent_id: c1 } as never], 0);
    archive.setChannelPolicy(c1, { hideInPrivacy: true });
    expect(check()).toBe(2);
    archive.upsertChannels(g1, [{ id: c2, name: 'b', type: 0, parent_id: c1 }]);
    expect(check()).toBe(3);
    archive.setGuildHideInPrivacy(g2, true);
    archive.upsertChannels(g2, [{ id: c3, name: 'c', type: 0 }]);
    expect(check()).toBe(5);
    archive.setChannelPolicy(c1, { hideInPrivacy: false });
    archive.setGuildHideInPrivacy(g2, false);
    expect(check()).toBe(0);
  });

  it('re-derives dependents when a rename replaces a marked row with an unmarked one', () => {
    const { db, check, run } = scoped();
    setSetting(db, 'privacyMode', true);
    run(guild, 'g1', 'G');
    run(guild, 'g2', 'G');
    run('UPDATE guilds SET hide_in_privacy = 1 WHERE id = ?', 'g1');
    run(channel, 'parent', 'g2', 'p', null);
    run('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?', 'parent');
    run(channel, 'child', 'g2', 'c', 'parent');
    run(channel, 'other', 'g2', 'o', null);
    run(channel, 'inG1', 'g1', 'x', null);
    expect(check()).toBe(4);
    run("UPDATE OR REPLACE channels SET id = 'parent' WHERE id = 'other'");
    run("UPDATE OR REPLACE guilds SET id = 'g1' WHERE id = 'g2'");
    expect(check()).toBe(0);
  });

  it('corrects, on upgrade, a scope a rename left wrong', () => {
    const db = new Database(join(tempDir(), 'old.db'));
    const cut = migrationIndex(HIDDEN_SCOPE_RENAMES);
    applyMigrations(db, 0, cut);
    setSetting(db, 'privacyMode', true);
    db.prepare(guild).run('g1', 'G');
    db.prepare('INSERT INTO channels (id, guild_id, name, kind, parent_id, hide_in_privacy) VALUES (?, ?, ?, 0, ?, ?)').run('parent', 'g1', 'p', null, 1);
    db.prepare(channel).run('child', 'g1', 'c', 'parent');
    db.prepare(channel).run('other', 'g1', 'o', null);
    db.exec("UPDATE OR REPLACE channels SET id = 'parent' WHERE id = 'other'");
    expect(ids(db, 'hidden_channels')).toEqual(['child']);
    applyMigrations(db, cut);
    expect(scoped(db).check()).toBe(0);
  });

  it('matches the views through a long random run of writes', () => {
    const { db, check, run } = scoped();
    /** A fixed-seed generator, so a failure replays. */
    let seed = 135;
    /** Park-Miller: exact in doubles, and every bit varies. */
    const next = (n: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % n;
    };
    const RANDOM_WRITES = 600;
    const pick = (prefix: string, n: number): string => `${prefix}${next(n)}`;
    const writes: (() => void)[] = [
      () => run('INSERT OR IGNORE INTO guilds (id, name, hide_in_privacy) VALUES (?, ?, ?)', pick('g', 4), 'G', next(2)),
      () => run('INSERT OR REPLACE INTO guilds (id, name, hide_in_privacy) VALUES (?, ?, ?)', pick('g', 4), 'G', next(2)),
      () => run('UPDATE guilds SET hide_in_privacy = ? WHERE id = ?', next(2), pick('g', 4)),
      () => run('DELETE FROM guilds WHERE id = ?', pick('g', 4)),
      () => run('UPDATE OR IGNORE guilds SET id = ? WHERE id = ?', pick('g', 4), pick('g', 4)),
      () => run('UPDATE OR REPLACE guilds SET id = ? WHERE id = ?', pick('g', 4), pick('g', 4)),
      () => run('INSERT OR IGNORE INTO channels (id, guild_id, name, kind, parent_id, hide_in_privacy) VALUES (?, ?, ?, 0, ?, ?)',
        pick('c', 12), pick('g', 4), 'c', next(3) ? pick('c', 12) : null, next(2)),
      () => run('INSERT OR REPLACE INTO channels (id, guild_id, name, kind, parent_id, hide_in_privacy) VALUES (?, ?, ?, 0, ?, ?)',
        pick('c', 12), pick('g', 4), 'c', next(3) ? pick('c', 12) : null, next(2)),
      () => run('UPDATE channels SET hide_in_privacy = ? WHERE id = ?', next(2), pick('c', 12)),
      () => run('UPDATE channels SET parent_id = ? WHERE id = ?', next(3) ? pick('c', 12) : null, pick('c', 12)),
      () => run('UPDATE channels SET guild_id = ? WHERE id = ?', pick('g', 4), pick('c', 12)),
      () => run('UPDATE OR IGNORE channels SET id = ? WHERE id = ?', pick('c', 12), pick('c', 12)),
      () => run('UPDATE OR REPLACE channels SET id = ? WHERE id = ?', pick('c', 12), pick('c', 12)),
      () => run('DELETE FROM channels WHERE id = ?', pick('c', 12)),
      () => setSetting(db, 'privacyMode', next(4) > 0),
    ];
    let hiddenSeen = 0;
    for (let i = 0; i < RANDOM_WRITES; i++) {
      writes[next(writes.length)]!();
      hiddenSeen += check();
    }
    expect(hiddenSeen).toBeGreaterThan(0);
  });

  it('is filled from an existing archive on upgrade, privacy mode on', () => {
    const db = new Database(join(tempDir(), 'old.db'));
    const cut = migrationIndex(HIDDEN_SCOPE_TABLE);
    applyMigrations(db, 0, cut);
    const fixture = seedPerfArchive(db, TEST_ARCHIVE);
    hideSome(db, fixture);
    const before = { channels: ids(db, 'hidden_channels'), ids: ids(db, 'hidden_ids') };
    applyMigrations(db, cut);
    expect({ channels: ids(db, 'hidden_channels'), ids: ids(db, 'hidden_ids') }).toEqual(before);
    expect(before.ids.length).toBeGreaterThan(0);
  });
});
