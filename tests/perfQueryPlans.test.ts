// Hot archive reads over a realistically shaped archive: indexed plans, and the same results as the unindexed reads.
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db';
import { privacyScope } from '../src/core/queries/privacy';
import { HIDDEN_SCOPE_TABLE } from '../src/core/hiddenScope';
import { UNGUARDED_MESSAGES, VIEWS_BEFORE_SCOPE_TABLE, persistViews } from './frozenArchiveViews';
import { applyMigrations, migrationIndex, tempDb, tempDir } from './helpers';
import { statementPlans } from './queryPlan';
import { TEST_ARCHIVE, hideSome, seedPerfArchive } from './perfArchiveFixture';

/** The migration that adds the share lookup by link. */
const SHARES_BY_LINK = 'ON message_links (link_id';

/** The perf archive at test scale. */
const seedArchive = (db: Db): ReturnType<typeof seedPerfArchive> => seedPerfArchive(db, TEST_ARCHIVE);

/** Whole-archive totals over the privacy-filtered messages view: the heaviest per-message privacy read. */
const archiveTotals = (db: Db): { messages: number; authors: number } =>
  db.prepare('SELECT COUNT(*) AS messages, COUNT(DISTINCT m.author_id) AS authors FROM archive_messages m').get() as { messages: number; authors: number };

const indexesOn = (db: Db, table: string): string[] =>
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").pluck().all(table) as string[];

describe('message link shares', () => {
  it('indexes the shares of an existing archive on upgrade, keeping every share', () => {
    const db = new Database(join(tempDir(), 'old.db'));
    const cut = migrationIndex(SHARES_BY_LINK);
    applyMigrations(db, 0, cut);
    db.exec("INSERT INTO message_links (message_id, link_id) VALUES ('m1', 1), ('m2', 1), ('m2', 2)");
    expect(indexesOn(db, 'message_links')).toEqual([]);
    applyMigrations(db, cut);
    expect(indexesOn(db, 'message_links')).toHaveLength(1);
    expect(db.prepare('SELECT message_id, link_id FROM message_links ORDER BY message_id, link_id').all()).toEqual([
      { message_id: 'm1', link_id: 1 },
      { message_id: 'm2', link_id: 1 },
      { message_id: 'm2', link_id: 2 },
    ]);
  });
});

/** archive_messages checks whether anything is hidden once per statement, then each message against the hidden ids alone. */
function expectScopeCheckedOnce(db: Db): void {
  const details = statementPlans(db, () => archiveTotals(db)).join('\n');
  // Whether anything is hidden: an uncorrelated subquery, run once.
  expect(details).toMatch(/(?<!CORRELATED )SCALAR SUBQUERY \d+\nSCAN hidden_ids\b/);
  // Per message: a scan of the few hidden ids, never the channels and servers the scope derives from.
  expect(details).toMatch(/CORRELATED SCALAR SUBQUERY \d+\nSCAN h\b/);
  expect(details).not.toMatch(/SCAN c\b|SEARCH p\b|SCAN guilds|COMPOUND QUERY/);
}

/** Visible messages computed outside SQL from the privacy scope: the parity oracle. */
function visibleMessages(db: Db): { id: string; author_id: string }[] {
  const { channelIds, guildIds } = privacyScope(db);
  const hidden = [...channelIds, ...guildIds];
  return (db.prepare('SELECT id, channel_id, author_id, content FROM messages').all() as { id: string; channel_id: string; author_id: string; content: string }[])
    .filter((m) => !channelIds.includes(m.channel_id) && !hidden.some((id) => m.content.includes(id)));
}

describe('archive messages under privacy mode', () => {
  it.each([false, true])('checks the scope once per statement and each message against the hidden ids alone (hiding: %s)', (hiding) => {
    const db = tempDb();
    const fixture = seedArchive(db);
    if (hiding) hideSome(db, fixture);
    expectScopeCheckedOnce(db);
  });

  it('counts exactly the messages privacy mode leaves visible, on and off', () => {
    const db = tempDb();
    const fixture = seedArchive(db);
    const expectVisible = (): void => {
      const visible = visibleMessages(db);
      const totals = archiveTotals(db);
      expect(totals.messages).toBe(visible.length);
      expect(totals.authors).toBe(new Set(visible.map((m) => m.author_id)).size);
      expect(db.prepare('SELECT id FROM archive_messages ORDER BY id').pluck().all()).toEqual(visible.map((m) => m.id).sort());
    };
    expectVisible();
    hideSome(db, fixture);
    expectVisible();
    expect(visibleMessages(db).length).toBeLessThan(TEST_ARCHIVE.messages);
  });
});

describe('archive views of an existing archive', () => {
  it('replaces a persisted view that checks the hidden scope per message on upgrade', () => {
    const path = join(tempDir(), 'old.db');
    const old = new Database(path);
    applyMigrations(old, 0, migrationIndex(HIDDEN_SCOPE_TABLE));
    persistViews(old, { ...VIEWS_BEFORE_SCOPE_TABLE, archive_messages: UNGUARDED_MESSAGES });
    const fixture = seedArchive(old);
    old.close();
    const db = openDb(path);
    expect(archiveTotals(db).messages).toBe(TEST_ARCHIVE.messages);
    hideSome(db, fixture);
    expectScopeCheckedOnce(db);
  });
});

/** The privacy-filtered reads whose results must not change with how the scope is stored. */
function privacyReads(db: Db) {
  const all = (view: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${view} ORDER BY ${order}`).all();
  return {
    totals: archiveTotals(db),
    // Unordered lists (no ORDER BY): the views listed ids in channel order, the table lists them in id order.
    scope: Object.values(privacyScope(db)).map((list: string[]) => [...list].sort()),
    messages: all('archive_messages', 'id'),
    channels: all('archive_channels', 'id'),
    guilds: all('archive_guilds', 'id'),
    archiveLinks: all('archive_links', 'id'),
    shares: all('archive_message_links', 'message_id, link_id'),
    names: all('archive_names', 'channel_id, user_id'),
  };
}

/** Timeout for migrating and seeding two performance archives. */
const SEEDED_ARCHIVES_TIMEOUT_MS = 30_000;

describe('the privacy scope as a table', () => {
  it('reads what the views read, with privacy mode off, hiding some, and after the hidden set changes', () => {
    const archive = (upToDate: boolean) => {
      const path = join(tempDir(), 'scope.db');
      if (upToDate) {
        const db = openDb(path);
        return { db, fixture: seedArchive(db) };
      }
      const db = new Database(path);
      applyMigrations(db, 0, migrationIndex(HIDDEN_SCOPE_TABLE));
      persistViews(db, VIEWS_BEFORE_SCOPE_TABLE);
      return { db, fixture: seedArchive(db) };
    };
    const views = archive(false);
    const table = archive(true);
    const both = (change: (a: ReturnType<typeof archive>) => void): void => {
      change(views);
      change(table);
      expect(privacyReads(table.db)).toEqual(privacyReads(views.db));
    };
    both(() => undefined);
    both((a) => hideSome(a.db, a.fixture));
    both((a) => a.db.prepare('UPDATE channels SET hide_in_privacy = 1 WHERE id = ?').run(a.fixture.threads[1]));
    both((a) => a.db.prepare('UPDATE guilds SET hide_in_privacy = 0').run());
    expect(privacyScope(table.db).channelIds.length).toBeGreaterThan(0);
  }, SEEDED_ARCHIVES_TIMEOUT_MS);
});
