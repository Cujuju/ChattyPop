// Contract tests for text retention.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_SETTINGS, type ArchiveSettings } from '@shared/settings';
import { MS_PER_DAY } from '@shared/units';
import type { Db } from '../src/core/db';
import { messagePage } from '../src/core/queries/messages';
import { TextRetentionRunner, applyTextRetention } from '../src/core/textRetention';
import { registerTextCoverage } from '../src/core/textCoverage';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const CH = '200000000000000001';
const NOW = Date.UTC(2026, 8, 24);
const OLD = NOW - 100 * MS_PER_DAY;
const RECENT = NOW - MS_PER_DAY;

let db: Db;
const settings = (s: Partial<ArchiveSettings>): ArchiveSettings => ({ ...DEFAULT_ARCHIVE_SETTINGS, textTierAfterDays: 90, ...s });
const kinds = () =>
  db.prepare('SELECT content, typeof(raw_json) AS raw, pruned_at IS NOT NULL AS pruned FROM messages ORDER BY ts').all() as {
    content: string;
    raw: string;
    pruned: number;
  }[];

beforeEach(() => {
  db = tempDb();
  const a = seedArchive(db, [{ id: CH }]);
  a.ingestMessages([
    rawMessage(CH, OLD, 'old covered', { embeds: [{ type: 'link', url: 'https://example.com', title: 'Example' }] }),
    rawMessage(CH, OLD + MS_PER_DAY, 'old uncovered'),
    rawMessage(CH, RECENT, 'recent'),
  ], ARRIVAL.gateway);
  // An owner (e.g. a summary) covering only the first message's time; disposed after the test.
  return registerTextCoverage(() => [{ channelIds: [CH], since: OLD - 1, until: OLD + 1 }]);
});

describe('text retention', () => {
  it('full tier changes nothing', async () => {
    expect(await applyTextRetention(db, settings({ textTier: 'full' }), NOW)).toEqual({ compressed: 0, pruned: 0, overCapBytes: 0 });
  });

  it('compresses old payloads losslessly: queries still read them', async () => {
    const r = await applyTextRetention(db, settings({ textTier: 'compressed' }), NOW);
    expect(r.compressed).toBe(2);
    expect(kinds()).toEqual([
      { content: 'old covered', raw: 'blob', pruned: 0 },
      { content: 'old uncovered', raw: 'blob', pruned: 0 },
      { content: 'recent', raw: 'text', pruned: 0 },
    ]);
    const page = messagePage(db, { channelId: CH, limit: 10 });
    expect(page[0]!.embeds[0]).toMatchObject({ url: 'https://example.com', title: 'Example' });
  });

  it('summary-only removes text only where an owner covers it', async () => {
    const r = await applyTextRetention(db, settings({ textTier: 'summary-only' }), NOW);
    expect(r.pruned).toBe(1);
    expect(kinds().map((k) => k.content)).toEqual(['', 'old uncovered', 'recent']);
    expect(messagePage(db, { channelId: CH, limit: 10 })[0]!.prunedAt).not.toBeNull();
  });

  it('reports what stays over the cap when nothing more may go', async () => {
    const r = await applyTextRetention(db, settings({ textTier: 'full', textCapGb: 1e-9 }), NOW);
    expect(r.compressed).toBe(3);
    expect(r.pruned).toBe(0);
    expect(r.overCapBytes).toBeGreaterThan(0);
  });
});

describe('text retention keeps important messages', () => {
  it('never compresses or removes a message Jev scored notable', async () => {
    const covered = db.prepare("SELECT id FROM messages WHERE content = 'old covered'").pluck().get() as string;
    db.prepare("INSERT INTO jev_judgments (message_id, subject, value, model, judged_at) VALUES (?, 'notable', 0.9, 'fake', 0)").run(covered);
    const r = await applyTextRetention(db, settings({ textTier: 'summary-only', textCapGb: 1e-9 }), NOW, true);
    expect(r.pruned).toBe(0);
    expect(kinds()).toEqual([
      { content: 'old covered', raw: 'text', pruned: 0 },
      { content: 'old uncovered', raw: 'blob', pruned: 0 },
      { content: 'recent', raw: 'blob', pruned: 0 },
    ]);
  });

  it('without the setting, notable scores are ignored', async () => {
    const covered = db.prepare("SELECT id FROM messages WHERE content = 'old covered'").pluck().get() as string;
    db.prepare("INSERT INTO jev_judgments (message_id, subject, value, model, judged_at) VALUES (?, 'notable', 0.9, 'fake', 0)").run(covered);
    expect((await applyTextRetention(db, settings({ textTier: 'summary-only' }), NOW)).pruned).toBe(1);
  });
});

describe('TextRetentionRunner', () => {
  it('runs one pass at a time and never drops a request made mid-run', async () => {
    let passes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new TextRetentionRunner(async () => {
      passes++;
      if (passes === 1) await gate;
      return { compressed: 0, pruned: 0, overCapBytes: passes };
    }, () => undefined);
    const first = runner.request();
    await runner.request(); // mid-run: queued, returns at once
    await runner.request(); // coalesces with the queued one
    release();
    await first;
    expect(passes).toBe(2);
    expect(runner.overCapBytes).toBe(2);
  });
});
