// Jev's per-message judgments: one request per message, stored scores, and catch-up after an interrupted rescan.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MS_PER_DAY, MS_PER_MIN } from '@shared/units';
import type { Db } from '../src/core/db';
import { batchKey } from '../src/core/jev/messageBatch';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import type { RuleMatcher } from '../src/core/rules/matcher';
import type { FakeJev } from './fakeJev';
import { OWNER, arrivedLive, settleAsync } from './helpers';
import { probeRule, ruleHarness, runsOf, type Harness } from './ruleHarness';

const OTHER = 'u2';

let h: Harness;
let db: Db;
let jev: FakeJev;
let rules: Harness['rules'];
let w: RuleMatcher;
const unregister: (() => void)[] = [];
beforeEach(() => {
  h = ruleHarness();
  ({ db, jev, rules, matcher: w } = h);
  jev.on.topicMeaning = true;
  w.setSelf(OWNER);
});
afterEach(() => unregister.splice(0).forEach((f) => f()));

let seq = 0;
const live = (content: string, authorId = OTHER) => ({
  id: `m${++seq}`,
  channelId: 'c1',
  authorId,
  ts: Date.now(),
  content,
  linked: '',
});
const topic = (pattern: string, description: string | null) =>
  rules.create(
    probeRule(
      { ...(pattern ? { text: { pattern, spec: null } } : {}), ...(description ? { meaning: description } : {}) },
      { name: pattern || description! },
    ),
  );
/** A per-message question a plugin would register, on while its switch `feature` is. */
const perMessage = (subject: string, feature: `${string}.${string}`): void => {
  unregister.push(registerMessageQuestion({ subject, feature, question: () => ({ type: 'noul', instructions: `${subject}?` }) }));
  jev.on[feature] = true;
};
const scores = (messageId: string) =>
  db.prepare('SELECT subject, value FROM jev_judgments WHERE message_id = ? ORDER BY subject').all(messageId);

describe('Jev message judgments', () => {
  it('asks every question for a message in one request and stores every score, below the cut-off too', async () => {
    const t = topic('', 'group buys');
    perMessage('urgency', 'r2.urgent');
    perMessage('aimed', 'r2.aimed');
    jev.values = { [`rule:${t}`]: 0.3, urgency: 0.4, aimed: 0.2 };
    const m = live('anyone seen the new keyboard?');
    w.check(m, arrivedLive());
    await settleAsync();
    expect(jev.requests).toHaveLength(1);
    expect(Object.keys(jev.requests[0]!.questions).sort()).toEqual(['aimed', `rule:${t}`, 'urgency']);
    expect(scores(m.id)).toEqual([
      { subject: 'aimed', value: 0.2 },
      { subject: `rule:${t}`, value: 0.3 },
      { subject: 'urgency', value: 0.4 },
    ]);
    expect(runsOf(h, t)).toEqual([]); // below the rule's cut-off
  });

  it('forgets a rule’s scores when the rule is deleted', async () => {
    const t = topic('', 'group buys');
    jev.values = { [`rule:${t}`]: 0.9 };
    const m = live('GB closes friday');
    w.check(m, arrivedLive());
    await settleAsync();
    expect(scores(m.id)).toHaveLength(1);
    rules.remove(t);
    expect(scores(m.id)).toEqual([]);
  });
});

describe('Jev catch-up after an interrupted rescan', () => {
  const store = (id: string, content: string, ts = Date.now() - MS_PER_MIN, authorId = OTHER) =>
    db
      .prepare('INSERT INTO messages (id, channel_id, author_id, ts, content) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'c1', authorId, ts, content);

  it('judges each unjudged lookback message once, and nothing on a second run', async () => {
    jev.on.topicMeaning = false; // created with Jev off: the rescan asks nothing, so no rows
    store('a1', 'shall we meet on friday');
    store('a2', 'the patch notes are out');
    store('a3', 'plans: friday at 6', Date.now() - MS_PER_MIN, OWNER.id);
    store('old', 'ancient friday plans', Date.now() - 2 * MS_PER_DAY);
    const plans = topic('', 'making plans to meet up');
    await settleAsync();
    expect(jev.requests).toHaveLength(0);

    jev.on.topicMeaning = true;
    jev.values = { [`rule:${plans}`]: 0.1 };
    w.catchUpJudgments();
    await settleAsync();
    // a1, a2 and the owner's own a3 (meaning rules judge everyone's messages) in one batched request; 'old' is outside the lookback
    expect(jev.requests).toHaveLength(1);
    expect(Object.keys(jev.requests[0]!.questions).sort()).toEqual(
      ['a1', 'a2', 'a3'].map((id) => batchKey(`rule:${plans}`, id)),
    );

    jev.requests = [];
    w.catchUpJudgments();
    await settleAsync();
    expect(jev.requests).toHaveLength(0);
  });

  it("doesn't ask about a rule's own keyword hits", async () => {
    jev.on.topicMeaning = false;
    store('b1', 'shall we meet on friday');
    store('b2', 'the patch notes are out');
    topic('friday', 'making plans to meet up'); // keywords or meaning: b1 matches on keywords
    await settleAsync();
    jev.on.topicMeaning = true;
    w.catchUpJudgments();
    await settleAsync();
    expect(jev.requests).toHaveLength(1);
    expect(JSON.stringify(jev.requests[0]!.state)).toContain('patch notes');
  });
});
