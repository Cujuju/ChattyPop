import { expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin, MS_PER_DAY, MS_PER_S } from '@plugin-sdk/shared';
import { defineCorePlugin, type Rollup } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import * as readers from '../src/core/reads/archiveReads';
import { installRollupStore } from '../src/core/rollups/store';
import { tempDb } from './helpers';

const START = Date.UTC(2026, 0, 1);
const DAYS = 3; // Distinguish the finite enumeration from a continuously dirtied newest day.
const SETTLE_MS = 20_000;
const probe = definePlugin({ manifest: { id: 'buildprobe', name: 'Build probe', version: '1', description: '' },
  channels: defineChannels<{ core: { count(): { n: number }[] } }>()({ core: { count: { audiences: ['renderer'], reads: true } } }) });

function fixture() {
  let rollup!: Rollup;
  const core = defineCorePlugin(probe, (ctx) => {
    rollup = ctx.rollups.define('counts', { version: 1, columns: { bucket: 'TEXT', n: 'INTEGER' }, key: ['bucket'], dependsOn: ['messages'],
      compute: async (p, read) => read(`SELECT '' AS bucket, COUNT(*) AS n FROM archive_all_rollup_messages
        WHERE channel_id = ? AND ts >= ? AND ts < ?`, [p.channelId, p.startTs, p.endTs]),
    });
    ctx.channels.serve({ count: () => ctx.storage.read(`SELECT SUM(n) AS n FROM (
      SELECT n FROM ${rollup.view} UNION ALL SELECT COUNT(*) AS n FROM ${rollup.liveView} p
      JOIN archive_rollup_messages m ON m.channel_id = p.channel_id
        AND m.ts >= unixepoch(p.day) * ${MS_PER_S} AND m.ts < unixepoch(p.day, '+1 day') * ${MS_PER_S})`) });
  });
  const t = testPlugin(core, { archive: { channels: [{ id: 'c' }], messages: Array.from({ length: DAYS }, (_, day) =>
    ({ channelId: 'c', ts: START + day * MS_PER_DAY, content: 'stored' })) } });
  onTestFinished(() => t.dispose());
  const settle = () => expect.poll(() => rollup.status().maintaining, { timeout: SETTLE_MS }).toBe(false);
  return { t, rollup, settle };
}

it('finishes enumerated work while every compute is superseded by live inserts and references remain pending', async () => {
  const { t, rollup, settle } = fixture();
  await settle();
  const original = readers.computeArchive;
  let inserted = 0, continuous = true;
  const spy = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (continuous && args[1].partition) {
      const part = args[1].partition as { startTs: number };
      t.archive.arrive([{ channelId: 'c', ts: part.startTs + ++inserted, content: 'live' }]);
    }
    return result as never;
  });
  onTestFinished(() => spy.mockRestore());
  rollup.rebuild();
  await expect.poll(() => rollup.status().building, { timeout: SETTLE_MS }).toBe(false);
  continuous = false;
  expect(inserted).toBeGreaterThanOrEqual(DAYS);
  expect(t.db.prepare('SELECT COUNT(*) FROM rollup_build_parts').pluck().get()).toBe(0);
  expect(t.db.prepare('SELECT COUNT(*) FROM rollup_reference_changes').pluck().get()).toBeGreaterThan(0);
  expect(rollup.status().maintaining).toBe(true);
  spy.mockRestore();
  await settle();
  expect(await t.client('renderer').count()).toEqual([{ n: DAYS + inserted }]);
  rollup.rebuild(); await settle();
  expect(await t.client('renderer').count()).toEqual([{ n: DAYS + inserted }]);
});

it('drains older work when every compute is followed by another newest-day insert', async () => {
  const { t, rollup, settle } = fixture();
  await settle();
  const original = readers.computeArchive;
  let inserted = 0, continuous = true;
  const spy = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (continuous && args[1].partition) t.archive.arrive([{ channelId: 'c', ts: START + (DAYS - 1) * MS_PER_DAY + ++inserted, content: 'newest' }]);
    return result as never;
  });
  try {
    rollup.markDirty([{ channelId: 'c', day: '2026-01-01' }, { channelId: 'c', day: '2026-01-03' }]);
    await expect.poll(() => Boolean(t.db.prepare("SELECT 1 FROM rollup_dirty WHERE day = '2026-01-01'").get()), { timeout: SETTLE_MS }).toBe(false);
    expect(inserted).toBeGreaterThan(0);
    expect(rollup.status()).toMatchObject({ building: false, maintaining: true });
  } finally { continuous = false; spy.mockRestore(); }
  await settle();
  expect(await t.client('renderer').count()).toEqual([{ n: DAYS + inserted }]);
});

it('does not turn an existing incrementally dirty archive into a full build on upgrade', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  db.exec(`CREATE TABLE rollup_meta (rollup TEXT PRIMARY KEY, version INTEGER, zone TEXT, built_through_seq INTEGER DEFAULT 0,
    queued_through_seq INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, backfill INTEGER DEFAULT 1);
    INSERT INTO rollup_meta(rollup, version, zone, backfill) VALUES ('old.counts', 1, 'UTC', 0), ('old.new', 1, 'UTC', 1)`);
  installRollupStore(db);
  expect(db.prepare('SELECT rollup, full_build FROM rollup_meta ORDER BY rollup').all()).toEqual([
    { rollup: 'old.counts', full_build: 0 }, { rollup: 'old.new', full_build: 1 },
  ]);
});

it('adopts remaining round-two work without re-enumeration and clears an idle accidental gate', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  db.exec(`CREATE TABLE rollup_meta (rollup TEXT PRIMARY KEY, version INTEGER, zone TEXT, built_through_seq INTEGER DEFAULT 0,
    queued_through_seq INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, backfill INTEGER DEFAULT 1, full_build INTEGER DEFAULT 1);
    INSERT INTO rollup_meta(rollup, version, zone, backfill) VALUES ('old.counts', 1, 'UTC', 0), ('old.idle', 1, 'UTC', 0);
    CREATE TABLE rollup_dirty(rollup TEXT, channel_id TEXT, day TEXT, revision INTEGER DEFAULT 1, PRIMARY KEY(rollup, channel_id, day));
    INSERT INTO rollup_dirty VALUES ('old.counts', 'c', '2026-01-01', 1)`);
  installRollupStore(db); installRollupStore(db);
  expect(db.prepare('SELECT * FROM rollup_build_parts').all()).toEqual([{ rollup: 'old.counts', channel_id: 'c', day: '2026-01-01' }]);
  expect(db.prepare('SELECT full_build FROM rollup_meta ORDER BY rollup').pluck().all()).toEqual([1, 0]);
});
