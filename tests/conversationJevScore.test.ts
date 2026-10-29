// Jev against the chooser on held-out replies: bands, its picks, read scope and cost.
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { ARRIVAL } from '@core/arrival';
import { ConversationLinkJob } from '@core/conversations/job';
import { scoreJevOnReplies } from '@core/conversations/jevScore';
import { isHeldOut } from '@core/conversations/score';
import { argmax, COMBINED_SIGNALS, combinedPick, crossFittedPicks, fitCombined, type CombinedCase } from '@core/conversations/jevCombine';
import { FakeJev, score as scoreAnswer, type JevRequest } from './fakeJev';
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

type Said = { from: string; text: string };
type Relates = { instructions: { earlier_message: Said; question: string } };
/** Rates the earlier message asking the answer's own question as responded to (level 2), the rest as unrelated. */
const pickQuestion = (req: JevRequest): Record<string, unknown> => {
  const n = (req.state as { message: Said }).message.text.match(/answer (\d+)/)![1];
  const answers: Record<string, unknown> = { responds: { type: 'noul', noul: 0.9 } };
  for (const [id, q] of Object.entries(req.questions)) {
    if (!id.startsWith('relates_')) continue;
    const hit = (q as unknown as Relates).instructions.earlier_message.text.endsWith(`question ${n}?`);
    answers[id] = hit ? scoreAnswer(1.9, { 0: 0, 1: 0.1, 2: 0.9 }) : scoreAnswer(0.1, { 0: 0.9, 1: 0.1, 2: 0 });
  }
  return answers;
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
    const score = await scoreJevOnReplies(db, jev, { release: 'jev-next' });
    const total = (k: 'asked' | 'answered' | 'relatesExact' | 'respondsYes') => score.bands.reduce((n, b) => n + b[k], 0);
    const held = messages.filter((m) => m.channel_id === 'open' && m.message_reference && isHeldOut(m.id)).length;
    // Held-out replies a rule decides (bob answering right after himself) aren't the chooser's to compare.
    const asked = total('asked');
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(held);
    expect([total('answered'), total('relatesExact'), total('respondsYes')]).toEqual([asked, asked, asked]);
    expect(score.byJevConfidence.reduce((n, b) => n + b.exact, 0)).toBe(asked);
    const chooserExact = score.bands.reduce((n, b) => n + b.chooserExact, 0);
    const combinedExact = score.bands.reduce((n, b) => n + b.combinedExact, 0);
    expect(score.discordant.combinedOnly - score.discordant.chooserOnly).toBe(combinedExact - chooserExact);
    expect(jev.requests).toHaveLength(asked);
    expect(jev.requests.map((r) => JSON.stringify(r)).filter((s) => !s.includes('open') || s.includes('secret'))).toEqual([]);
    expect(jev.requests.every((r) => typeof r.admit === 'function')).toBe(true);
    expect(jev.requests.every((r) => r.release === 'jev-next')).toBe(true);
    expect(score.model).toBe('jev-next');
    // State is the message alone; each candidate rides in its own Score question, never in shared state.
    for (const r of jev.requests) {
      expect(Object.keys(r.state as object)).toEqual(['message']);
      const ids = Object.keys(r.questions);
      expect(ids[0]).toBe('responds');
      expect(ids.length).toBeGreaterThan(1);
      ids.slice(1).forEach((id, i) => {
        expect(id).toBe(`relates_${i}`);
        expect(r.questions[id]!.type).toBe('score');
        expect((r.questions[id] as unknown as Relates).instructions.question).toContain('`earlier_message`');
      });
    }
    expect(score.costUsd).toBeCloseTo(asked * 0.001);
    expect(score.failed).toBe(0);
    expect(score.failure).toBeNull();
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
    expect(score.model).toBe('fake-jev');
    expect(score.failure).toBe('Jev down');
  });

  it('leaves out replies whose channel turned local-AI-only before their request was sent: not asked, not failed', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'open' }]);
    archive.ingestMessages(exchange('open', 'open'), ARRIVAL.sync);
    await new ConversationLinkJob(() => db).run();
    const jev = new FakeJev();
    const decide = jev.decide.bind(jev);
    let sending = 0;
    // Turned local-only while the requests waited; the send-time check (admit) refuses them.
    jev.decide = async (req) => {
      sending++;
      archive.setChannelPolicy('open', { localAiOnly: true, textTier: null });
      req.admit?.();
      return decide(req);
    };
    const score = await scoreJevOnReplies(db, jev);
    expect(sending).toBeGreaterThan(0);
    expect(score.bands.reduce((n, b) => n + b.asked, 0)).toBe(0); // refused: not asked
    expect(score.failed).toBe(0);
    expect(score.failure).toBeNull();
  });
});

describe('chooser and Jev combined', () => {
  const CASES = 60;
  const CANDIDATES = 5;
  /** The chooser favours a wrong candidate; Jev's Score favours the target; its top-level probability says nothing. */
  const cases: CombinedCase[] = Array.from({ length: CASES }, (_, n) => {
    const target = n % CANDIDATES;
    const wrong = (target + 1) % CANDIDATES;
    const idx = [...Array(CANDIDATES).keys()];
    return {
      chooser: idx.map((j) => (j === wrong ? 0.6 : 0.1)),
      level: idx.map((j) => (j === target ? 0.8 : 0.2)),
      top: idx.map(() => 1 / CANDIDATES),
      target,
    };
  });

  it('starts as the chooser alone and learns the signal that predicts', () => {
    expect(cases.every((c) => argmax(c.chooser) !== c.target)).toBe(true);
    const w = fitCombined(cases);
    expect(w[COMBINED_SIGNALS.indexOf('level')]).toBeGreaterThan(w[COMBINED_SIGNALS.indexOf('chooser')]!);
    expect(cases.every((c) => combinedPick(c, w) === c.target)).toBe(true);
    expect(fitCombined([])).toEqual([1, 0, 0]);
  });

  it('scores each case with weights fitted on the other half', () => {
    expect(crossFittedPicks(cases)).toEqual(cases.map((c) => c.target));
  });
});
