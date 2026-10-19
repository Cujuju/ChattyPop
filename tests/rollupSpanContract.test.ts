import { expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin, MS_PER_DAY, MS_PER_MIN } from '@plugin-sdk/shared';
import { defineCorePlugin, type Rollup } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import * as readers from '../src/core/reads/archiveReads';

const START = Date.UTC(2026, 0, 1);
const SETTLE_MS = 10_000; // Native worker startup needs a bounded polling allowance on loaded Windows runners.
const probe = definePlugin({ manifest: { id: 'spanprobe', name: 'Span probe', version: '1', description: '' },
  channels: defineChannels<{ core: { rows(): { n: number }[] } }>()({ core: { rows: { audiences: ['renderer'], reads: true } } }) });

function start() {
  let rollup!: Rollup;
  const core = defineCorePlugin(probe, (ctx) => {
    rollup = ctx.rollups.define('runs', { version: 1, columns: { opener: 'TEXT', first_ts: 'INTEGER', last_ts: 'INTEGER', n: 'INTEGER' },
      key: ['opener'], dependsOn: ['messages', 'edits', 'deletes'], span: { start: 'first_ts', end: 'last_ts', paddingMs: MS_PER_MIN },
      compute: async (part, read) => read(`SELECT MIN(id) AS opener, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n
        FROM archive_all_rollup_messages WHERE channel_id = ? HAVING MIN(ts) >= ? AND MIN(ts) < ?`, [part.channelId, part.startTs, part.endTs]),
    });
    ctx.channels.serve({ rows: () => ctx.storage.read(`SELECT n FROM ${rollup.view}`) });
  });
  const t = testPlugin(core, { archive: { channels: [{ id: 'c1' }, { id: 'c2' }] } });
  onTestFinished(() => t.dispose());
  const settle = () => expect.poll(() => { const s = rollup.status(); if (s.error) throw new Error(s.error); return s.building; }, { timeout: SETTLE_MS }).toBe(false);
  return { t, rollup: () => rollup, settle };
}

it('recomputes an unpublished opener when a cross-midnight continuation arrives during its first compute', async () => {
  const { t, rollup, settle } = start();
  const original = readers.computeArchive;
  let inserted = false;
  const compute = vi.spyOn(readers, 'computeArchive').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!inserted && (args[1].partition as { day: string }).day === '2026-01-01') {
      inserted = true;
      expect(t.db.prepare('SELECT * FROM p_spanprobe_rollup_runs_v1').all()).toEqual([]);
      t.archive.arrive([{ channelId: 'c1', ts: START + MS_PER_DAY + MS_PER_MIN, content: 'continuation' }]);
    }
    return result as never;
  });
  onTestFinished(() => compute.mockRestore());
  t.archive.arrive([{ channelId: 'c1', ts: START + MS_PER_DAY - MS_PER_MIN, content: 'opener' },
    { channelId: 'c1', ts: START + MS_PER_DAY, content: 'reply' }]);
  await settle();
  expect(inserted).toBe(true);
  const incremental = await t.client('renderer').rows();
  expect(incremental).toEqual([{ n: 3 }]);
  rollup().rebuild(); await settle();
  expect(await t.client('renderer').rows()).toEqual(incremental);
  expect(t.db.prepare('SELECT * FROM rollup_dirty UNION ALL SELECT rollup, channel_id, first_day, revision FROM rollup_span_dirty').all()).toEqual([]);
});

it('keeps unaffected channel and day snapshots serving while a span request is pending', async () => {
  const { t, rollup, settle } = start();
  t.archive.arrive([{ channelId: 'c1', ts: START + MS_PER_DAY, content: 'later' }, { channelId: 'c2', ts: START, content: 'other' }]);
  await settle();
  t.db.prepare("INSERT INTO rollup_span_dirty(rollup, channel_id, first_day, last_day) VALUES ('spanprobe.runs', 'c1', '2026-01-01', '2026-01-01')").run();
  expect(rollup().snapshot()).toBeNull();
  expect(rollup().snapshot({ channelIds: ['c2'] })).not.toBeNull();
  expect(rollup().snapshot({ channelIds: ['c1'], firstDay: '2026-01-02' })).not.toBeNull();
  expect(rollup().snapshot({ channelIds: ['c1'] })).toBeNull();
  expect(t.db.prepare(`SELECT channel_id FROM ${rollup().view} ORDER BY channel_id`).pluck().all()).toEqual(['c1', 'c2']);
});
