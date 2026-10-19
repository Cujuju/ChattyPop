import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { compressRawJson, readStatus, setSetting } from '../src/core/db';
import { messagePage, messageWindow } from '../src/core/queries/messages';
import { ownEmoji, ownReactions } from '../src/core/queries/ownEmoji';
import { messagePageAsync, messageWindowAsync, ownEmojiAsync, ownReactionsAsync } from '../src/core/queries/hostAsync';
import { closeArchiveReads } from '../src/core/reads/archiveReads';
import { seedArchive, tempDb } from './helpers';

/** Matches the reaction ranker's maximum history, with compressed payloads large enough to expose native work. */
const HISTORY_ROWS = 20_000;
/** Payload text exercises repeated compressed JSON extraction without a large on-disk fixture. */
const PAYLOAD_CHARS = 16_384;
/** The Links/Archive default first-page measurement. */
const PAGE_ROWS = 50;

describe('heavy host read paths', () => {
  it('preserves reaction ranking, page/window hydration and privacy without archive SQL on Core', async () => {
    const db = tempDb();
    seedArchive(db, [{ id: 'open' }, { id: 'hidden' }]);
    db.prepare("INSERT INTO users (id, username, global_name) VALUES ('owner', 'owner', 'Owner')").run();
    db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'hidden'").run();
    const payload = compressRawJson(JSON.stringify({ content: 'x'.repeat(PAYLOAD_CHARS), reactions: [
      { emoji: { id: null, name: '🔥' }, me: true }, { emoji: { id: 'emoji', name: 'wave', animated: true }, me: true },
      { emoji: { id: null, name: '😂' }, me: false, me_burst: true },
    ] }));
    const insert = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let n = 0; n < HISTORY_ROWS; n++) insert.run(String(n), n % 2 ? 'open' : 'hidden', 'owner', n, 'Hello 🔥', payload);
    })();
    try {
      for (const privacy of [false, true]) {
        setSetting(db, 'privacyMode', privacy);
        const start = performance.now();
        const reactions = ownReactions(db, PAGE_ROWS);
        const reactionSyncMs = performance.now() - start;
        const query = { channelId: 'open', limit: PAGE_ROWS };
        const pageStart = performance.now();
        const page = messagePage(db, query);
        const pageSyncMs = performance.now() - pageStart;
        const window = messageWindow(db, { ...query, around: page[0]!.id });
        const emoji = ownEmoji(db, 'owner', PAGE_ROWS);
        const coreSql = vi.spyOn(db, 'prepare');
        let turns = 0;
        const heartbeat = setInterval(() => { turns++; }, 0);
        const dispatched = performance.now();
        const ranked = ownReactionsAsync(db, PAGE_ROWS);
        const dispatchMs = performance.now() - dispatched;
        try {
          expect(await ranked).toEqual(reactions);
          expect(turns).toBeGreaterThan(0);
          expect(await messagePageAsync(db, query)).toEqual(page);
          expect(await messageWindowAsync(db, { ...query, around: page[0]!.id })).toEqual(window);
          expect(await ownEmojiAsync(db, 'owner', PAGE_ROWS)).toEqual(emoji);
          expect(coreSql).not.toHaveBeenCalled();
          console.log(JSON.stringify({ privacy, rows: HISTORY_ROWS, pageRows: PAGE_ROWS, reactionSyncMs, pageSyncMs, dispatchMs, responsiveTurns: turns }));
        } finally { clearInterval(heartbeat); coreSql.mockRestore(); }
      }
      const controller = new AbortController();
      controller.abort(new Error('Superseded host read'));
      await expect(ownReactionsAsync(db, PAGE_ROWS, controller.signal)).rejects.toBe(controller.signal.reason);
      await expect(messagePageAsync(db, { channelId: 'open', limit: PAGE_ROWS }, controller.signal)).rejects.toBe(controller.signal.reason);
    } finally { await closeArchiveReads(db); db.close(); }
  });

  it('reads SQLite metadata off Core and asynchronously sizes missing side files', async () => {
    const db = tempDb();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const coreSql = vi.spyOn(db, 'prepare');
    const corePragma = vi.spyOn(db, 'pragma');
    try {
      const status = await readStatus(db, db.name, 123, false);
      expect(status).toMatchObject({ dbPath: db.name, mediaBytes: 123, encrypted: false, fts5: true });
      expect(status.totalBytes).toBe(status.dbBytes + status.mediaBytes);
      expect(status.dbBytes).toBeGreaterThanOrEqual((await stat(db.name)).size);
      const missing = await readStatus(db, db.name + '.missing', 0, false);
      expect(missing.dbBytes).toBe(0);
      expect(coreSql).not.toHaveBeenCalled();
      expect(corePragma).not.toHaveBeenCalled();
    } finally { coreSql.mockRestore(); corePragma.mockRestore(); await closeArchiveReads(db); db.close(); }
  });
});
