// Contract tests for channel policy.
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_SETTINGS } from '@shared/settings';
import { MS_PER_DAY } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { localOnlyChannelIds, textTierOverrides } from '../src/core/channelPolicy';
import type { Db } from '../src/core/db';
import { directory } from '../src/core/queries/directory';
import { applyTextRetention } from '../src/core/textRetention';
import { FakeJev } from './fakeJev';
import { rawMessage, seedArchive, settleAsync, tempDb, tempDir } from './helpers';
import { hostRuleStack, ruleInput } from './hostRules';
import { ARRIVAL } from '../src/core/arrival';
import { arrivedLive } from './helpers';

const PRIVATE = '200000000000000001';
const OPEN = '200000000000000002';
const THREAD = '300000000000000001';

let db: Db;
let archive: Archive;
beforeEach(() => {
  db = tempDb();
  archive = seedArchive(db, [{ id: PRIVATE }, { id: OPEN }]);
  archive.upsertThreads([{ id: THREAD, name: 'side talk', type: 11, parent_id: PRIVATE, last_message_id: null }], 0);
  archive.setChannelPolicy(PRIVATE, { localAiOnly: true, textTier: 'full' });
});

describe('per-channel policy', () => {
  it('applies to the channel and its threads', () => {
    expect(localOnlyChannelIds(db)).toEqual(new Set([PRIVATE, THREAD]));
    expect(textTierOverrides(db)).toEqual(
      new Map([
        [PRIVATE, 'full'],
        [THREAD, 'full'],
      ]),
    );
  });

  it('reaches the renderer in effect: a thread shows as local-only under its local-only channel', () => {
    const channels = directory(db, 0).flatMap((g) => g.channels);
    const localOnly = (id: string): boolean | undefined => channels.find((c) => c.id === id)?.localAiOnly;
    expect([localOnly(PRIVATE), localOnly(THREAD), localOnly(OPEN)]).toEqual([true, true, false]);
  });

  it('keeps local-only text away from Jev on every path', async () => {
    const jev = new FakeJev();
    const { matcher: w, rules } = hostRuleStack(db, () => {}, () => jev);
    w.setSelf({ id: 'me', username: 'me' });
    const record = { id: 'file', type: 'file', config: { path: join(tempDir(), 'plans.md'), format: 'markdown' } };
    rules.create(ruleInput([record], { match: { meaning: 'making plans' }, gates: { missed: true }, name: 'plans' }));
    const now = Date.now();
    w.check({ id: 'p1', channelId: PRIVATE, authorId: 'u2', ts: now, content: 'let us meet friday', linked: '' }, arrivedLive());
    w.check({ id: 't1', channelId: THREAD, authorId: 'u2', ts: now, content: 'friday works', linked: '' }, arrivedLive());
    await settleAsync();
    expect(jev.requests).toHaveLength(0);
    w.check({ id: 'o1', channelId: OPEN, authorId: 'u2', ts: now, content: 'let us meet friday', linked: '' }, arrivedLive());
    await settleAsync();
    expect(jev.requests.length).toBeGreaterThan(0);
  });

  it("uses a channel's own text tier over the global one", async () => {
    const old = Date.now() - 100 * MS_PER_DAY;
    archive.ingestMessages([rawMessage(PRIVATE, old, 'kept as captured'), rawMessage(OPEN, old + 1, 'compressed')], ARRIVAL.gateway);
    await applyTextRetention(db, { ...DEFAULT_ARCHIVE_SETTINGS, textTier: 'compressed', textTierAfterDays: 90 }, Date.now());
    const kinds = db.prepare('SELECT channel_id AS c, typeof(raw_json) AS raw FROM messages ORDER BY c').all();
    expect(kinds).toEqual([
      { c: PRIVATE, raw: 'text' },
      { c: OPEN, raw: 'blob' },
    ]);
  });
});
