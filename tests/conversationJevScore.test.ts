// Jev against the chooser on held-out replies: bands, its picks, read scope and cost.
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { ARRIVAL } from '@core/arrival';
import { ConversationLinkJob } from '@core/conversations/job';
import { scoreJevOnReplies } from '@core/conversations/jevScore';
import { isHeldOut } from '@core/conversations/score';
import { NO_PARENT } from '@core/conversations/ask';
import { choice, FakeJev, type JevRequest } from './fakeJev';
import { rawMessage, seedArchive, tempDb } from './helpers';

const T0 = Date.UTC(2026, 8, 1, 12);
const ann = { id: '100000000000000001', username: 'ann' };
const bob = { id: '100000000000000002', username: 'bob' };
const PAIRS = 20;
/** A message at `ms` whose id's low bits are `n` (Discord's per-process counter), so ids hold both halves of the score's split. */
const at = (channel: string, ms: number, n: number, content: string, extra: Partial<RawMessage>): RawMessage =>
  rawMessage(channel, ms, content, { id: (BigInt(snowflakeFromMs(ms)) + BigInt(n)).toString(), ...extra });
/** Questions three at a time, then their answers: each answer has earlier questions to choose among. */
function exchange(channel: string, word: string, start = T0): RawMessage[] {
  const out: RawMessage[] = [];
  for (let i = 0; i < PAIRS; i += 3) {
    const asked = [i, i + 1, i + 2].filter((n) => n < PAIRS).map((n) => at(channel, start + (n * 2) * MS_PER_MIN, n, `${word} question ${n}?`, { author: ann }));
    out.push(...asked, ...asked.map((q, k) => at(channel, start + ((i + k) * 2 + 5) * MS_PER_MIN, i + k, `${word} answer ${i + k}`,
      { author: bob, type: 19, message_reference: { message_id: q.id } } as Partial<RawMessage>)));
  }
  return out;
}

/** Picks the earlier line asking the answer's own question. */
const pickQuestion = (req: JevRequest): Record<string, unknown> => {
  const state = req.state as { message: string; earlier: string[] };
  const n = state.message.match(/answer (\d+)/)![1];
  const line = state.earlier.find((l) => l.endsWith(`question ${n}?`));
  return { parent: choice(line ? line.split('.')[0]! : NO_PARENT, 0.9) };
};

describe('conversation Jev score', () => {
  it('asks Jev about held-out replies by chooser band, never from a local-AI-only channel', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'open' }, { id: 'private' }]);
    archive.setChannelPolicy('private', { localAiOnly: true, textTier: 'full' });
    const messages = [...exchange('open', 'open'), ...exchange('private', 'secret', T0 + MS_PER_HOUR)];
    archive.ingestMessages(messages, ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
    const jev = new FakeJev(pickQuestion, 0.001);
    const score = await scoreJevOnReplies(db, jev);
    const total = (k: 'asked' | 'answered' | 'jevExact' | 'jevLinks' | 'jevLinksExact') => score.bands.reduce((n, b) => n + b[k], 0);
    const held = messages.filter((m) => m.channel_id === 'open' && m.message_reference && isHeldOut(m.id)).length;
    // Held-out replies a rule decides (bob answering right after himself) aren't the chooser's to compare.
    const asked = total('asked');
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(held);
    expect([total('answered'), total('jevExact'), total('jevLinks'), total('jevLinksExact')]).toEqual([asked, asked, asked, asked]);
    expect(jev.requests).toHaveLength(asked);
    expect(jev.requests.map((r) => JSON.stringify(r.state)).filter((s) => !s.includes('open') || s.includes('secret'))).toEqual([]);
    expect(jev.requests.every((r) => typeof r.admit === 'function')).toBe(true);
    // Every option carries its own message text; earlier lines say how long before they came.
    const criteria = jev.requests.map((r) => (r.questions.parent as { criteria: Record<string, string | null> }).criteria);
    expect(criteria.every((c) => Object.values(c).every((d) => !!d))).toBe(true);
    expect(jev.requests.every((r) => (r.state as { earlier: string[] }).earlier.every((l) => /^\d+\. \(\d+ min before\) /.test(l)))).toBe(true);
    expect(score.costUsd).toBeCloseTo(asked * 0.001);
    expect(score.failed).toBe(0);
  });

  it('counts failed requests and keeps going', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'open' }]);
    archive.ingestMessages(exchange('open', 'open'), ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
    const jev = new FakeJev();
    jev.fail = true;
    const score = await scoreJevOnReplies(db, jev);
    expect(score.failed).toBe(score.bands.reduce((n, b) => n + b.asked, 0));
    expect(score.bands.reduce((n, b) => n + b.answered, 0)).toBe(0);
  });
});
