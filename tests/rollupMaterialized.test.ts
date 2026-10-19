import { expect, it, onTestFinished, vi } from 'vitest';
import { defineCorePlugin, type Rollup } from '@plugin-sdk/core';
import { definePlugin, defineChannels, MS_PER_DAY } from '@plugin-sdk/shared';
import { testPlugin } from '@plugin-sdk/core/testing';
import * as reads from '../src/core/reads/archiveReads';

const START = Date.UTC(2026, 0, 1);
const SETTLE_MS = 20_000; // Include native helper startup under a concurrent test run.
const probe = definePlugin({ manifest: { id: 'foldprobe', name: 'Fold probe', version: '1', description: '' },
  channels: defineChannels<{ core: { rows(): unknown[] } }>()({ core: { rows: { audiences: ['renderer'], reads: true } } }) });

function start() {
  let rollup!: Rollup;
  const core = defineCorePlugin(probe, (ctx) => {
    rollup = ctx.rollups.define('counts', {
      version: 1, columns: { key: 'TEXT', n: 'INTEGER' }, key: ['key'], dependsOn: ['messages', 'edits', 'deletes'],
      compute: (p, read) => read(`SELECT 'n' AS key, COUNT(*) AS n FROM archive_all_rollup_messages WHERE channel_id = ? AND ts >= ? AND ts < ?`, [p.channelId, p.startTs, p.endTs]),
      fold: { columns: { key: 'TEXT', n: 'INTEGER' }, key: ['key'],
        compute: (channel, read, _signal, data) => read(`SELECT key, SUM(n) AS n FROM "${data.table}" WHERE channel_id = ? GROUP BY key`, [channel]) },
    });
    ctx.channels.serve({ rows: () => ctx.storage.read(`SELECT * FROM ${rollup.foldView}`) });
  });
  const t = testPlugin(core, { archive: { channels: [{ id: 'channel' }] } });
  onTestFinished(() => t.dispose());
  const settle = async () => expect.poll(() => { const s = rollup.status(); if (s.error) throw new Error(s.error); return s.building; }, { timeout: SETTLE_MS }).toBe(false);
  return { t, rollup: () => rollup, settle };
}

it('publishes exact materialized folds after arrivals, deletion and rebuild', async () => {
  const { t, rollup, settle } = start();
  const ids = t.archive.arrive([2, 0, 1].map((day) => ({ channelId: 'channel', ts: START + day * MS_PER_DAY, content: 'text' })));
  await settle();
  const visibility = rollup().visibilityToken();
  expect(rollup().snapshot()).not.toBeNull();
  expect(await t.client('renderer').rows()).toEqual([{ channel_id: 'channel', key: 'n', n: 3 }]);
  t.db.prepare('DELETE FROM messages WHERE id = ?').run(ids[0]); await settle();
  expect(rollup().visibilityToken()).toBe(visibility);
  expect(await t.client('renderer').rows()).toEqual([{ channel_id: 'channel', key: 'n', n: 2 }]);
  t.db.prepare("INSERT INTO hidden_ids(id, kind) VALUES ('channel', 'channel')").run();
  expect(rollup().visibilityToken()).not.toBe(visibility);
  rollup().rebuild(); await settle();
  expect(await t.client('renderer').rows()).toEqual([{ channel_id: 'channel', key: 'n', n: 2 }]);
});

it('rejects a fold computed before a concurrent mutation and repairs it before becoming clean', async () => {
  const { t, rollup, settle } = start(); await settle();
  const original = reads.computeArchive;
  let inserted = false;
  const spy = vi.spyOn(reads, 'computeArchive').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (typeof args[1].partition === 'string' && !inserted) {
      inserted = true;
      t.archive.arrive([{ channelId: 'channel', ts: START + MS_PER_DAY, content: 'second' }]);
      expect(rollup().snapshot()).toBeNull();
      expect(await t.client('renderer').rows()).toEqual([]);
    }
    return result as never;
  });
  try {
    t.archive.arrive([{ channelId: 'channel', ts: START, content: 'first' }]); await settle();
  } finally { spy.mockRestore(); }
  expect(inserted).toBe(true);
  expect(await t.client('renderer').rows()).toEqual([{ channel_id: 'channel', key: 'n', n: 2 }]);
});
