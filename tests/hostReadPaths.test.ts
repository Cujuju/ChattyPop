import { stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { compressRawJson, readStatus, setSetting } from '../src/core/db';
import { messagePage, messageWindow } from '../src/core/queries/messages';
import { ownEmoji, ownReactions } from '../src/core/queries/ownEmoji';
import { messagePageAsync, messageWindowAsync, ownEmojiAsync, ownReactionsAsync } from '../src/core/queries/hostAsync';
import { archiveReadPrivacyChanged, closeArchiveReads } from '../src/core/reads/archiveReads';
import { statusMetadata } from '../src/core/archiveStatus';
import { registerMessageLabels } from '../src/core/messageLabels';
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
          const pageStart = performance.now();
          const pendingPage = messagePageAsync(db, query);
          const pageDispatchMs = performance.now() - pageStart;
          expect(await pendingPage).toEqual(page);
          expect(await messageWindowAsync(db, { ...query, around: page[0]!.id })).toEqual(window);
          expect(await ownEmojiAsync(db, 'owner', PAGE_ROWS)).toEqual(emoji);
          expect(coreSql).not.toHaveBeenCalled();
          process.stdout.write(JSON.stringify({ privacy, rows: HISTORY_ROWS, pageRows: PAGE_ROWS, reactionSyncMs, pageSyncMs, dispatchMs, pageDispatchMs, responsiveTurns: turns }) + '\n');
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
    const before = performance.now();
    statusMetadata(db);
    const sizes = ['', '-wal', '-shm'].map((suffix) => existsSync(db.name + suffix) ? statSync(db.name + suffix).size : 0);
    const legacyCoreMs = performance.now() - before;
    const coreSql = vi.spyOn(db, 'prepare');
    const corePragma = vi.spyOn(db, 'pragma');
    try {
      const start = performance.now();
      const pending = readStatus(db, db.name, 123, false);
      const dispatchMs = performance.now() - start;
      const status = await pending;
      expect(status).toMatchObject({ dbPath: db.name, mediaBytes: 123, encrypted: false, fts5: true });
      expect(status.totalBytes).toBe(status.dbBytes + status.mediaBytes);
      expect(status.dbBytes).toBe(sizes.reduce((a, b) => a + b, 0));
      expect(status.dbBytes).toBeGreaterThanOrEqual((await stat(db.name)).size);
      const missing = await readStatus(db, db.name + '.missing', 0, false);
      expect(missing.dbBytes).toBe(0);
      expect(coreSql).not.toHaveBeenCalled();
      expect(corePragma).not.toHaveBeenCalled();
      process.stdout.write(JSON.stringify({ status: true, legacyCoreMs, dispatchMs }) + '\n');
    } finally { coreSql.mockRestore(); corePragma.mockRestore(); await closeArchiveReads(db); db.close(); }
  });

  it('yields between live enrichment batches and refuses pages invalidated during those turns', async () => {
    const db = tempDb(); seedArchive(db, [{ id: 'c' }]);
    const put = db.prepare("INSERT INTO messages (id, channel_id, author_id, ts, content) VALUES (?, 'c', 'u', ?, '')");
    db.transaction(() => { for (let n = 0; n < PAGE_ROWS; n++) put.run(String(n), n); })();
    try {
      for (const reason of ['privacy', 'cancel']) {
        const control = new AbortController();
        let changed = false;
        const dispose = registerMessageLabels('yieldprobe', 0, () => {
          if (!changed) {
            changed = true;
            setImmediate(() => { if (reason === 'privacy') archiveReadPrivacyChanged(db); else control.abort(new Error('Page superseded')); });
          }
          return new Map();
        });
        try {
          await expect(messagePageAsync(db, { channelId: 'c', limit: PAGE_ROWS }, control.signal))
            .rejects.toThrow(reason === 'privacy' ? 'Archive visibility changed' : 'Page superseded');
        } finally { dispose(); }
      }
    } finally { await closeArchiveReads(db); db.close(); }
  });
});
