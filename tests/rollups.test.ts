import { afterEach, describe, expect, it, vi } from 'vitest';
import * as readers from '../src/core/reads/archiveReads';
import { defineChannels, definePlugin, MS_PER_DAY } from '@plugin-sdk/shared';
import { defineCorePlugin, type Rollup, type RollupRow } from '@plugin-sdk/core';
import { testPlugin, type TestPlugin } from '@plugin-sdk/core/testing';
import { noteRollupChange } from '../src/core/rollups/service';
import { seedRollupReferences } from '../src/core/rollups/privacy';

const START = Date.UTC(2026, 0, 1);
const CHANNEL = '200000000000000001';
const HIDDEN = '200000000000000002';
const SETTLE_TIMEOUT_MS = 10_000; // Full-suite worker startup can exceed Vitest's one-second polling default.
const probe = definePlugin({
  manifest: { id: 'rollupprobe', name: 'Rollup probe', version: '1', description: '' },
  channels: defineChannels<{ core: { rows(): { n: number; sum: number }[]; ping(): number } }>()({
    core: { rows: { audiences: ['renderer'], reads: true }, ping: ['renderer'] },
  }),
});
const active: TestPlugin<typeof probe>[] = [];
afterEach(async () => { for (const t of active.splice(0)) await t.dispose(); });

function start(version = () => 1, zone = false) {
  let rollup!: Rollup;
  const core = defineCorePlugin(probe, (ctx) => {
    rollup = ctx.rollups.define('counts', {
      version: version(), columns: { bucket: 'TEXT', n: 'INTEGER', sum: 'INTEGER' }, key: ['bucket'],
      allTime: { values: { n: 'sum', sum: 'sum' } },
      dependsOn: ['messages', 'edits', 'deletes', 'names', 'channels'], timeZoneSensitive: zone,
      compute: async (part, read) => {
        if ((globalThis as Record<string, unknown>).rollupCoreSentinel) throw new Error('Compute ran on Core');
        return read<RollupRow>(`SELECT ? AS bucket, COUNT(*) AS n, COALESCE(SUM(length(content)), 0) AS sum
          FROM archive_all_rollup_messages WHERE channel_id = ? AND ts >= ? AND ts < ?`, [part.timeZone, part.channelId, part.startTs, part.endTs]);
      },
    });
    ctx.channels.serve({ rows: () => ctx.storage.read(`SELECT SUM(n) AS n, SUM(sum) AS sum FROM ${rollup.allTimeView}`), ping: () => 1 });
  });
  const t = testPlugin(core, { archive: { channels: [{ id: CHANNEL }, { id: HIDDEN, hidden: true }] } });
  active.push(t);
  return { t, rollup: () => rollup };
}

async function settled(rollup: Rollup) {
  await expect.poll(() => { const status = rollup.status(); if (status.error) throw new Error(status.error); return status.building; }, { timeout: SETTLE_TIMEOUT_MS }).toBe(false);
}

describe('host rollup contract', () => {
  it('keeps clean snapshots and unaffected rows serving when a thread is inserted or deleted', async () => {
    const reads = vi.spyOn(readers, 'readArchive');
    const { t, rollup } = start();
    t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'unaffected' }]);
    await settled(rollup());
    const db = reads.mock.calls[0]![0]; reads.mockRestore();
    for (const sql of [
      `INSERT INTO channels(id, name, kind, parent_id) VALUES ('new-thread', 'Thread', 11, '${CHANNEL}')`,
      "DELETE FROM channels WHERE id = 'new-thread'",
    ]) {
      t.db.prepare(sql).run();
      noteRollupChange(db, '', ['names', 'channels']);
      expect(rollup().snapshot()).not.toBeNull();
      expect(t.db.prepare(`SELECT n FROM ${rollup().view}`).pluck().all()).toEqual([1]);
      await settled(rollup());
      expect(rollup().snapshot()).not.toBeNull();
    }
  });

  it('searches only changed catalog ids and dirties only partitions that reference them', async () => {
    const reads = vi.spyOn(readers, 'readArchive');
    const { t, rollup } = start();
    const thread = '300000000000000099';
    t.archive.arrive([
      { channelId: CHANNEL, ts: START, content: `<#${thread}>` },
      { channelId: CHANNEL, ts: START + MS_PER_DAY, content: 'unaffected' },
    ]);
    await settled(rollup());
    const db = reads.mock.calls[0]![0];
    reads.mockRestore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = readers.computeArchive;
    const compute = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => { await held; return original(...args) as never; });
    try {
      t.db.prepare('INSERT INTO channels(id, name, kind, parent_id) VALUES (?, ?, 11, ?)').run(thread, 'Thread', CHANNEL);
      await seedRollupReferences(db, new AbortController().signal);
      expect(t.db.prepare('SELECT DISTINCT day FROM rollup_dirty').pluck().all()).toEqual(['2026-01-01']);
      expect(t.db.prepare(`SELECT n FROM ${rollup().view} WHERE day = '2026-01-02'`).pluck().all()).toEqual([1]);
    } finally { release(); compute.mockRestore(); }
    await settled(rollup());
  });

  it('performs zero full partition discoveries during an ordinary message drain', async () => {
    const { t, rollup } = start();
    await settled(rollup());
    const spy = vi.spyOn(readers, 'readArchive');
    try {
      t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'ordinary delta' }]);
      await settled(rollup());
      const discoveries = spy.mock.calls.filter(([, sql]) => sql.includes('AS watermark,') && sql.includes('AS partitions FROM'));
      expect(discoveries).toHaveLength(0);
      expect((await t.client('renderer').rows())[0]!.n).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])('folds arrival order %j independently of sequence', async (...order) => {
    const { t, rollup } = start();
    for (const day of order) {
      t.archive.arrive([{ channelId: CHANNEL, ts: START + day * MS_PER_DAY, content: 'one' }]);
      await settled(rollup());
    }
    const incremental = await t.client('renderer').rows();
    rollup().rebuild();
    await settled(rollup());
    expect(await t.client('renderer').rows()).toEqual(incremental);
    expect(incremental).toEqual([{ n: 3, sum: 9 }]);
  });
  it('runs compute off Core and incrementally equals rebuild under reverse arrivals, edits and deletes', async () => {
    (globalThis as Record<string, unknown>).rollupCoreSentinel = true;
    try {
      const { t, rollup } = start();
      const ids = t.archive.arrive([
        { channelId: CHANNEL, ts: START + MS_PER_DAY, content: 'second' },
        { channelId: CHANNEL, ts: START, content: 'first' },
      ]);
      await settled(rollup());
      expect(await t.client('renderer').rows()).toEqual([{ n: 2, sum: 11 }]);
      t.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited', ids[0]);
      t.db.prepare('DELETE FROM messages WHERE id = ?').run(ids[1]);
      await settled(rollup());
      const incremental = await t.client('renderer').rows();
      rollup().rebuild();
      await settled(rollup());
      expect(await t.client('renderer').rows()).toEqual(incremental);
      expect(incremental).toEqual([{ n: 1, sum: 6 }]);
      expect(await t.client('renderer').ping()).toBe(1);
    } finally { delete (globalThis as Record<string, unknown>).rollupCoreSentinel; }
  });

  it('filters hidden channels at read time and keeps known channel references live', async () => {
    const { t, rollup } = start();
    t.archive.arrive([
      { channelId: CHANNEL, ts: START, content: 'visible' },
      { channelId: HIDDEN, ts: START, content: 'secret' },
      { channelId: CHANNEL, ts: START, content: `<#${HIDDEN}>` },
    ]);
    await settled(rollup());
    t.archive.setPrivacyMode(true);
    expect(await t.client('renderer').rows()).toEqual([{ n: 1, sum: 7 }]);
    expect(await t.read('SELECT content FROM archive_residual_messages')).toEqual([]);
    t.archive.setPrivacyMode(false);
    expect(await t.client('renderer').rows()).toEqual([{ n: 2, sum: 13 }]);
    expect(await t.read('SELECT content FROM archive_residual_messages')).toHaveLength(1);
  });

  it.each(['channel', 'server'])('reclassifies newly known hidden %s ids without treating user mentions or emoji as residuals', async (kind) => {
    const { t, rollup } = start();
    const unknown = '300000000000000003';
    t.archive.arrive([
      { channelId: CHANNEL, ts: START, content: '<@400000000000000004>' },
      { channelId: CHANNEL, ts: START + 1, content: '<:wave:500000000000000005>' },
      { channelId: CHANNEL, ts: START + 2, content: `<#${unknown}>` },
    ]);
    await settled(rollup());
    expect((await t.client('renderer').rows())[0]!.n).toBe(3);
    expect(await t.read('SELECT id FROM archive_residual_messages')).toEqual([]);
    if (kind === 'channel') t.db.prepare('INSERT INTO channels(id, name, kind, hide_in_privacy) VALUES (?, ?, 0, 1)').run(unknown, 'Hidden');
    else t.db.prepare('INSERT INTO guilds(id, name, hide_in_privacy) VALUES (?, ?, 1)').run(unknown, 'Hidden');
    expect(t.db.prepare(`SELECT * FROM ${rollup().view}`).all()).toEqual([]);
    t.archive.setPrivacyMode(true);
    await settled(rollup());
    expect((await t.client('renderer').rows())[0]!.n).toBe(2);
    expect(await t.read('SELECT id FROM archive_residual_messages')).toEqual([]);
    t.archive.setPrivacyMode(false);
    expect(await t.read('SELECT id FROM archive_residual_messages')).toHaveLength(1);
    rollup().rebuild();
    await settled(rollup());
    expect((await t.client('renderer').rows())[0]!.n).toBe(2);
  });

  it('persists dirty work across restart and handles a version bump with additive tables', async () => {
    let version = 1;
    const state = start(() => version);
    state.t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'one' }]);
    await settled(state.rollup());
    state.t.db.prepare('UPDATE messages SET content = ?').run('changed');
    expect(state.t.db.prepare('SELECT COUNT(*) FROM rollup_dirty').pluck().get()).toBeGreaterThan(0);
    const restarted = state.t.restart();
    active.splice(active.indexOf(state.t), 1);
    active.push(restarted);
    expect(restarted.db.prepare('SELECT backfill FROM rollup_meta').pluck().get()).toBe(0);
    await settled(state.rollup());
    expect(await restarted.client('renderer').rows()).toEqual([{ n: 1, sum: 7 }]);
    await restarted.off();
    version++;
    await restarted.on();
    await settled(state.rollup());
    expect(state.rollup().view).toContain('_v2_visible');
    expect(await restarted.client('renderer').rows()).toEqual([{ n: 1, sum: 7 }]);
    expect(restarted.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'p_rollupprobe_rollup_counts_v1'").get()).toBeDefined();
  });

  it('discards a computed snapshot invalidated before its partition transaction', async () => {
    const original = readers.computeArchive;
    const { t, rollup } = start();
    const [id] = t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'old' }]);
    let invalidated = false;
    const spy = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (!invalidated) { invalidated = true; t.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('newer', id); }
      return rows as never;
    });
    try {
      await settled(rollup());
      expect(invalidated).toBe(true);
      expect(await t.client('renderer').rows()).toEqual([{ n: 1, sum: 5 }]);
    } finally { spy.mockRestore(); }
  });

  it('changes clean-build tokens after invalidation and completed replacements', async () => {
    const { t, rollup } = start();
    t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'one' }]);
    await settled(rollup());
    const first = rollup().snapshot();
    expect(first).not.toBeNull();
    t.db.prepare('UPDATE messages SET content = content, raw_json = raw_json').run();
    expect(rollup().snapshot()).toBe(first);
    t.db.prepare('UPDATE messages SET content = ?').run('changed');
    expect(rollup().snapshot()).toBeNull();
    await settled(rollup());
    expect(rollup().snapshot()).not.toBe(first);
    const beforeCatalog = rollup().snapshot();
    t.db.prepare("INSERT INTO channels(id, name, kind) VALUES ('new', 'New', 0)").run();
    expect(rollup().snapshot()).not.toBeNull();
    await settled(rollup());
    expect(rollup().snapshot()).not.toBe(beforeCatalog);
    const beforeVisibility = rollup().snapshot();
    t.archive.setPrivacyMode(true);
    expect(rollup().snapshot()).not.toBe(beforeVisibility);
    const hidden = rollup().snapshot();
    t.archive.setPrivacyMode(false);
    expect(rollup().snapshot()).not.toBe(hidden);
  });

  it('resumes only remaining partitions newest first when completed coverage trails queued coverage', async () => {
    const { t, rollup } = start();
    t.archive.arrive([0, 1, 2].map((day) => ({ channelId: CHANNEL, ts: START + day * MS_PER_DAY, content: 'one' })));
    await settled(rollup());
    t.db.prepare('UPDATE rollup_meta SET built_through_seq = 0').run();
    for (const day of ['2026-01-01', '2026-01-02']) t.db.prepare('INSERT INTO rollup_dirty(rollup, channel_id, day) VALUES (?, ?, ?)').run('rollupprobe.counts', CHANNEL, day);
    const days: string[] = [];
    const original = readers.computeArchive;
    const spy = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => {
      days.push((args[1].partition as { day: string }).day);
      return await original(...args) as never;
    });
    const restarted = t.restart();
    active.splice(active.indexOf(t), 1);
    active.push(restarted);
    try {
      await settled(rollup());
      expect(days).toEqual(['2026-01-02', '2026-01-01']);
      expect(await restarted.client('renderer').rows()).toEqual([{ n: 3, sum: 9 }]);
      rollup().markDirty([{ channelId: CHANNEL, day: '2026-01-03' }]);
      await settled(rollup());
      expect(days.at(-1)).toBe('2026-01-03');
    } finally { spy.mockRestore(); }
  });

  it('rebuilds scoped partitions and detects an operating-system time-zone change', async () => {
    const { t, rollup } = start(() => 1, true);
    t.archive.arrive([{ channelId: CHANNEL, ts: START, content: 'one' }]);
    await settled(rollup());
    rollup().rebuild({ channelIds: [CHANNEL] });
    await settled(rollup());
    const oldZone = process.env.TZ;
    try {
      process.env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC' ? 'America/New_York' : 'UTC';
      expect(rollup().status().building).toBe(true);
      await settled(rollup());
      expect(await t.client('renderer').rows()).toEqual([{ n: 1, sum: 3 }]);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(t.db.prepare('SELECT zone FROM rollup_meta').pluck().get()).toBe(zone);
      expect(t.db.prepare(`SELECT DISTINCT bucket FROM ${rollup().view}`).pluck().all()).toEqual([zone]);
    } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  });
});
