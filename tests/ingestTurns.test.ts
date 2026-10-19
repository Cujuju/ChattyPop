import { expect, it, onTestFinished, vi } from 'vitest';
import { Archive } from '../src/core/archive';
import { ARRIVAL } from '../src/core/arrival';
import { INGEST_MAX_ROWS } from '../src/core/ingestTurns';
import { ArchiveChanges } from '@shared/archiveChanges';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { installRollupStore } from '../src/core/rollups/store';
import { installRollupTriggers } from '../src/core/rollups/triggers';
import { installRollupReferences } from '../src/core/rollups/privacy';
import { writeStatement } from '../src/core/writeStatements';

const CHANNEL = '200000000000000001';
const START = Date.UTC(2026, 0, 1);
const ROWS = INGEST_MAX_ROWS * 3 + 1; // Cross three commit boundaries and leave a short final slice.
const page = () => Array.from({ length: ROWS }, (_, n) => rawMessage(CHANNEL, START + n, `message ${n}`, {
  attachments: [{ id: `file-${n}`, filename: 'file.txt', url: 'https://example.test/file' }],
  embeds: [],
}));
const yieldTurn = () => new Promise<void>((done) => setImmediate(done));

function fixture() {
  const db = tempDb(), archive = seedArchive(db, [{ id: CHANNEL }]);
  installRollupStore(db); installRollupTriggers(db); installRollupReferences(db);
  const changes = new ArchiveChanges(); archive.reportChangesWith(changes.add.bind(changes));
  onTestFinished(() => db.close());
  return { db, archive, changes };
}

it.each(['newer', 'older'] as const)('commits only a contiguous %s edge before yielding and resumes after restart', async (direction) => {
  const { db, archive, changes } = fixture();
  const input = page().reverse();
  const pending = archive.ingestSyncPageBatched(CHANNEL, input, direction, true, () => null);
  expect(db.inTransaction).toBe(false);
  const partial = archive.syncState(CHANNEL);
  expect(partial.count).toBe(INGEST_MAX_ROWS);
  expect(partial.backfillComplete).toBe(false);
  expect(partial.oldestId).toBe(input[direction === 'older' ? INGEST_MAX_ROWS - 1 : ROWS - 1]!.id);
  expect(partial.newestId).toBe(input[direction === 'older' ? 0 : ROWS - INGEST_MAX_ROWS]!.id);
  expect(db.prepare('SELECT COUNT(*) FROM attachments').pluck().get()).toBe(INGEST_MAX_ROWS);
  expect(db.prepare('SELECT COUNT(*) FROM rollup_changes').pluck().get()).toBeGreaterThan(0);
  expect(changes.take().inserted?.throughSeq).toBe(INGEST_MAX_ROWS);
  archive.setOptIn(CHANNEL, false);
  expect(await pending).toBeNull();
  const restarted = new Archive(db); restarted.setOptIn(CHANNEL, true);
  expect(await restarted.ingestSyncPageBatched(CHANNEL, input, direction, true, () => null)).toMatchObject({ inserted: ROWS - INGEST_MAX_ROWS });
  expect(restarted.syncState(CHANNEL)).toMatchObject({ count: ROWS, backfillComplete: direction === 'older' });
});

it('rolls back a failing slice, retains prior notifications, and makes retries idempotent', async () => {
  const { db, archive, changes } = fixture();
  const input = page();
  db.exec(`CREATE TRIGGER reject_ingest BEFORE INSERT ON messages WHEN NEW.content = 'message ${INGEST_MAX_ROWS + 1}'
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  await expect(archive.ingestMessagesBatched(input, ARRIVAL.import)).rejects.toThrow('fixture failure');
  expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(INGEST_MAX_ROWS);
  expect(db.prepare('SELECT COUNT(*) FROM attachments').pluck().get()).toBe(INGEST_MAX_ROWS);
  expect(changes.take().inserted?.throughSeq).toBe(INGEST_MAX_ROWS);
  db.exec('DROP TRIGGER reject_ingest');
  expect(await archive.ingestMessagesBatched(input, ARRIVAL.import)).toMatchObject({ inserted: ROWS - INGEST_MAX_ROWS });
  expect(await archive.ingestMessagesBatched(input, ARRIVAL.import)).toEqual({ inserted: 0, edited: 0, skipped: 0 });
});

it('stops a sync page if the account changes during a yield and rejects mismatched channels before writing', async () => {
  const { archive } = fixture(); let owner = 'one';
  const pending = archive.ingestSyncPageBatched(CHANNEL, page(), 'newer', false, () => owner);
  owner = 'two';
  expect(await pending).toBeNull();
  expect(archive.syncState(CHANNEL).count).toBe(INGEST_MAX_ROWS);
  expect(() => archive.ingestSyncPageBatched(CHANNEL, [rawMessage('other', START, 'wrong')], 'newer', false, () => null)).toThrow('another channel');
});

it('never leaves an atomic transaction across a yield and lets another task run between steps', async () => {
  const { db, archive } = fixture();
  expect(() => archive.atomically(() => archive.ingestMessagesBatched(page(), ARRIVAL.import))).toThrow('inside an atomic transaction');
  const pending = archive.ingestMessagesBatched(page(), ARRIVAL.import);
  await yieldTurn();
  expect(db.inTransaction).toBe(false);
  expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBeLessThan(ROWS);
  await pending;
});

it('reuses writer bytecode across commits and still observes rollback and schema changes', () => {
  const { db } = fixture();
  const prepare = vi.spyOn(db, 'prepare');
  const sql = 'SELECT COUNT(*) FROM users';
  const first = writeStatement(db, sql);
  expect(writeStatement(db, sql)).toBe(first);
  expect(prepare).toHaveBeenCalledTimes(1); prepare.mockRestore();
  db.exec('ALTER TABLE users ADD COLUMN fixture_flag INTEGER');
  expect(first.pluck().get()).toBe(0);
  expect(() => db.transaction(() => {
    db.exec("INSERT INTO users(id, username) VALUES ('probe', 'Probe')");
    expect(first.get()).toBe(1); throw new Error('rollback');
  })()).toThrow('rollback');
  expect(first.get()).toBe(0);
});
