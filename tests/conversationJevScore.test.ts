// Jev against the chooser on held-out replies: bands, its picks, read scope and cost.
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, MS_PER_MIN } from '@shared/units';
import { snowflakeFromMs, type RawMessage } from '@shared/discord';
import { ARRIVAL } from '@core/arrival';
import { ConversationLinkJob } from '@core/conversations/job';
import { scoreJevOnReplies } from '@core/conversations/jevScore';
import { isHeldOut } from '@core/conversations/score';
import { NO_PARENT } from '@core/conversations/ask';
import { argmax, COMBINED_SIGNALS, combinedPick, crossFittedPicks, fitCombined, type CombinedCase } from '@core/conversations/jevCombine';
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

type Said = { from: string; text: string; minutes_before?: number };
/** Rates the earlier message asking the answer's own question: the pick and its yes/no, both at 0.9. */
const pickQuestion = (req: JevRequest): Record<string, unknown> => {
  const state = req.state as { message: Said; earlier: Said[] };
  const n = state.message.text.match(/answer (\d+)/)![1];
  const i = state.earlier.findIndex((m) => m.text.endsWith(`question ${n}?`));
  const answers: Record<string, unknown> = { parent: choice(i < 0 ? NO_PARENT : `earlier[${i}]`, 0.9) };
  state.earlier.forEach((_, j) => (answers[`continues_${j}`] = { type: 'noul', noul: j === i ? 0.9 : 0.1 }));
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
    const total = (k: 'asked' | 'answered' | 'choiceExact' | 'continuesExact') => score.bands.reduce((n, b) => n + b[k], 0);
    const held = messages.filter((m) => m.channel_id === 'open' && m.message_reference && isHeldOut(m.id)).length;
    // Held-out replies a rule decides (bob answering right after himself) aren't the chooser's to compare.
    const asked = total('asked');
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(held);
    expect([total('answered'), total('choiceExact'), total('continuesExact')]).toEqual([asked, asked, asked]);
    expect(score.byJevConfidence.reduce((n, b) => n + b.choice.exact, 0)).toBe(asked);
    expect(jev.requests).toHaveLength(asked);
    expect(jev.requests.map((r) => JSON.stringify(r.state)).filter((s) => !s.includes('open') || s.includes('secret'))).toEqual([]);
    expect(jev.requests.every((r) => typeof r.admit === 'function')).toBe(true);
    expect(jev.requests.every((r) => r.release === 'jev-next')).toBe(true);
    expect(score.model).toBe('jev-next');
    // Structured state; one pick naming candidates by path, and one yes/no per candidate pointing at it.
    for (const r of jev.requests) {
      const earlier = (r.state as { earlier: Said[] }).earlier;
      expect(earlier.every((m) => typeof m.from === 'string' && typeof m.text === 'string' && typeof m.minutes_before === 'number')).toBe(true);
      const names = earlier.map((_, i) => `earlier[${i}]`);
      expect(Object.keys((r.questions.parent as { criteria: object }).criteria)).toEqual([...names, NO_PARENT]);
      expect(Object.keys(r.questions)).toEqual(['parent', ...names.map((_, i) => `continues_${i}`)]);
      names.forEach((n, i) => expect(r.questions[`continues_${i}`]!.instructions).toContain(`\`${n}\``));
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
});

describe('chooser and Jev combined', () => {
  const CASES = 60;
  const CANDIDATES = 5;
  /** The chooser favours a wrong candidate; Jev's yes/no favours the target; its pick says nothing. */
  const cases: CombinedCase[] = Array.from({ length: CASES }, (_, n) => {
    const target = n % CANDIDATES;
    const wrong = (target + 1) % CANDIDATES;
    const idx = [...Array(CANDIDATES).keys()];
    return {
      chooser: idx.map((j) => (j === wrong ? 0.6 : 0.1)),
      continues: idx.map((j) => (j === target ? 0.8 : 0.2)),
      choice: idx.map(() => 1 / CANDIDATES),
      target,
    };
  });

  it('starts as the chooser alone and learns the signal that predicts', () => {
    expect(cases.every((c) => argmax(c.chooser) !== c.target)).toBe(true);
    const w = fitCombined(cases);
    expect(w[COMBINED_SIGNALS.indexOf('continues')]).toBeGreaterThan(w[COMBINED_SIGNALS.indexOf('chooser')]!);
    expect(cases.every((c) => combinedPick(c, w) === c.target)).toBe(true);
    expect(fitCombined([])).toEqual([1, 0, 0]);
  });

  it('scores each case with weights fitted on the other half', () => {
    expect(crossFittedPicks(cases)).toEqual(cases.map((c) => c.target));
  });
});
