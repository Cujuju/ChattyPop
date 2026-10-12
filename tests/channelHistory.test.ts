import { describe, expect, it } from 'vitest';
import { BACKFILL_AMOUNT_MAX, backfillCutoffMs, normalizeArchiveSettings, resolveBackfillCutoffMs, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { FORUM_CHANNEL_TYPE, THREAD_CHANNEL_TYPES, snowflakeFromMs } from '@shared/discord';
import { MS_PER_DAY } from '@shared/units';
import { archiveHandlers } from '../src/core/archiveHandlers';
import { seedArchive, tempDb, rawMessage } from './helpers';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const PARENT = '200000000000000001';
const OTHER = '200000000000000002';
const THREAD = '300000000000000001';
const OTHER_THREAD = '300000000000000002';
const CHOICES: ChannelBackfillHistory[] = [
  { unit: 'days', amount: 7 }, { unit: 'months', amount: 6 }, { unit: 'years', amount: 2 }, 'complete', { sinceMs: NOW },
];
const overridesFrom = (channelBackfillHistory: unknown) => normalizeArchiveSettings({ channelBackfillHistory }).channelBackfillHistory;

describe('per-channel history normalization', () => {
  it.each(CHOICES)('round-trips %j, including choices for channels no longer archived', (choice) => {
    const stored = normalizeArchiveSettings({ channelBackfillHistory: { [PARENT]: choice, unarchived: choice } });
    expect(normalizeArchiveSettings(JSON.parse(JSON.stringify(stored))).channelBackfillHistory).toEqual({ [PARENT]: choice, unarchived: choice });
  });

  it.each([
    null, undefined, 'default', 'since', {}, [], { unit: 'weeks', amount: 1 }, { unit: 'days' },
    { unit: 'days', amount: '7' }, { unit: 'days', amount: null }, { unit: 'days', amount: false },
    { unit: 'days', amount: 0 }, { unit: 'days', amount: 1.5 }, { unit: 'days', amount: Infinity },
    { unit: 'years', amount: BACKFILL_AMOUNT_MAX.years + 1 },
    { sinceMs: 0 }, { sinceMs: -1 }, { sinceMs: NaN }, { sinceMs: Infinity }, { sinceMs: '1' },
  ])('drops invalid choice %j without dropping a valid neighbor', (invalid) => {
    expect(overridesFrom({ [PARENT]: invalid, [OTHER]: 'complete' })).toEqual({ [OTHER]: 'complete' });
  });

  it('drops symbol keys and maps with non-string keys; rejects arrays and empty keys', () => {
    expect(overridesFrom({ [Symbol('channel')]: 'complete', '': 'complete', [PARENT]: 'complete' })).toEqual({ [PARENT]: 'complete' });
    expect(overridesFrom(new Map([[42, 'complete']]))).toEqual({});
    expect(overridesFrom(['complete'])).toEqual({});
  });

  it.each([undefined, null, 'unreadable', 7])('an invalid or absent map %j leaves every channel at the default', (value) => {
    expect(overridesFrom(value)).toEqual({});
  });

  it('keeps fixed-time history out of the default choices', () => {
    expect(normalizeArchiveSettings({ backfillHistory: { sinceMs: NOW } }).backfillHistory).toEqual({ unit: 'days', amount: 30 });
  });
});

describe('channel history resolution', () => {
  const settings = normalizeArchiveSettings({ backfillHistory: { unit: 'days', amount: 30 }, channelBackfillHistory: { [PARENT]: 'complete', [THREAD]: { sinceMs: NOW } } });

  it('an override wins and a missing override uses the default', () => {
    expect(resolveBackfillCutoffMs(settings, PARENT, NOW)).toBe(backfillCutoffMs('complete', NOW));
    expect(resolveBackfillCutoffMs(settings, OTHER, NOW)).toBe(NOW - 30 * MS_PER_DAY);
  });

  it.each([...THREAD_CHANNEL_TYPES])('a thread of kind %i follows its parent, ignoring its own override', (kind) => {
    expect(resolveBackfillCutoffMs(settings, THREAD, NOW, { kind, parentId: PARENT })).toBe(backfillCutoffMs('complete', NOW));
    expect(resolveBackfillCutoffMs(settings, THREAD, NOW, { kind, parentId: OTHER })).toBe(NOW - 30 * MS_PER_DAY);
  });

  it('a forum or text channel uses its own choice, rather than its category', () => {
    for (const kind of [0, FORUM_CHANNEL_TYPE]) {
      expect(resolveBackfillCutoffMs(settings, OTHER, NOW, { kind, parentId: PARENT })).toBe(NOW - 30 * MS_PER_DAY);
    }
  });

  it('DM and group choices use their own fixed time regardless of now', () => {
    for (const kind of [1, 3]) {
      for (const now of [NOW, NOW + 10 * MS_PER_DAY]) {
        expect(resolveBackfillCutoffMs(settings, THREAD, now, { kind, parentId: null })).toBe(NOW);
      }
    }
  });

  it('does not mistake inherited object properties for overrides', () => {
    expect(resolveBackfillCutoffMs(settings, 'toString', NOW)).toBe(NOW - 30 * MS_PER_DAY);
  });
});

describe('thread upsert history per parent', () => {
  it('judges two parents separately through both sync handlers and gateway events', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: PARENT }, { id: OTHER }]);
    const settings = normalizeArchiveSettings({ backfillHistory: { unit: 'days', amount: 1 }, channelBackfillHistory: { [PARENT]: 'complete', [OTHER]: { sinceMs: NOW } } });
    const cutoff = (id: string) => resolveBackfillCutoffMs(settings, id, NOW, archive.channelInfo(id));
    const handlers = archiveHandlers({
      ready: () => ({ db, archive }), emit: () => undefined, noteChanged: () => undefined, backfillFromMs: cutoff,
      selfId: () => null, lastSeenAt: () => NOW, applyTextTier: async () => undefined, autoArchiveSinceMs: () => null,
    });
    const threads = [
      { id: THREAD, parent_id: PARENT, name: 'deep', type: 11, last_message_id: snowflakeFromMs(NOW - MS_PER_DAY) },
      { id: OTHER_THREAD, parent_id: OTHER, name: 'shallow', type: 11, last_message_id: snowflakeFromMs(NOW - MS_PER_DAY, 1) },
    ];
    handlers.applyGatewayEvent('THREAD_LIST_SYNC', { threads });
    threads.forEach((t, index) => archive.ingestSyncPage(t.id, [rawMessage(t.id, NOW - MS_PER_DAY, 'latest', { id: snowflakeFromMs(NOW - MS_PER_DAY, index) })], 'older', false));
    expect(handlers.upsertThreads(threads)).toEqual([THREAD]);
    expect(archive.channelInfo(THREAD)?.parentId).toBe(PARENT);
    expect(archive.channelInfo(OTHER_THREAD)?.parentId).toBe(OTHER);
    expect(archive.syncState(OTHER_THREAD).backfillComplete).toBe(false);
    handlers.applyGatewayEvent('THREAD_UPDATE', threads[0]);
    expect(archive.upsertThreads(threads, cutoff)).toEqual([THREAD]);
  });
});
