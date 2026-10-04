// Rule event identities and settlement across live, catch-up, rejudge and nested trigger paths.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JevFeature } from '@shared/settings';
import { ARRIVAL } from '../src/core/arrival';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import type { Settled } from '../src/core/rules/kinds';
import { textMessage } from '../src/core/queries/messageText';
import { FakeJev } from './fakeJev';
import { nextTs, rawMessage, seedArchive, tempDb } from './helpers';
import { hostRuleStack, ruleInput } from './hostRules';
import { activateProbe, includeProbe, probeAction } from './pluginRuleProbe';

includeProbe();

/** The per-message question that holds a matched event until it settles, as an urgency check would. */
const URGENCY = 'urgency';
/** A host switch no other question in this file uses. */
const URGENCY_FEATURE: JevFeature = 'keepImportant';
const ACTION = probeAction();
/** The probe's plugin trigger: starts a rule on a message, nested inside another event. */
const PROBE_TRIGGER = 'ruleprobe.start';

/** Disposers of the questions each test registered. */
const unregister: (() => void)[] = [];

/**
 * A probe-only rule stack. `pending()` counts events the probe action ran for that have not settled since: what an
 * action owner holding work until settlement would still hold.
 */
function stack() {
  const db = tempDb();
  const jev = new FakeJev();
  const { engine, matcher, rules } = hostRuleStack(db, () => undefined, jev.forFeature);
  const kinds = engine.kinds;
  let checking = true;
  const archive = seedArchive(db, [{ id: 'c1' }], {
    onText: (m, arrived) => {
      if (checking) matcher.check(m, arrived);
    },
  });
  const probe = activateProbe({ db, kinds, archive: () => archive, jev, now: Date.now });
  const settled: Settled[] = [];
  const cleared = new Set<(typeof probe.runs)[number]>();
  kinds.onSettled((e) => {
    settled.push(e);
    for (const r of probe.runs) if (r.event.kind === 'message' && r.event.eventId === e.eventId) cleared.add(r);
  });
  const unsettled = (r: (typeof probe.runs)[number]) =>
    !r.history && r.event.kind === 'message' && !cleared.has(r) ? [r.event.eventId] : [];
  const pending = () => new Set(probe.runs.flatMap(unsettled)).size;
  unregister.push(
    registerMessageQuestion({
      subject: URGENCY,
      feature: URGENCY_FEATURE,
      question: (_, c) => (c.live && c.mayAct(ACTION.type) ? { type: 'noul', instructions: 'Urgent?' } : null),
    }),
  );
  const say = (check = true) => {
    checking = check;
    const raw = rawMessage('c1', nextTs(), 'news');
    archive.ingestMessages([raw], ARRIVAL.gateway);
    return textMessage(db, raw.id)!;
  };
  return { jev, kinds, matcher, rules, pending, settled, say };
}

afterEach(() => {
  unregister.splice(0).forEach((off) => off());
  vi.restoreAllMocks();
});

describe('explicit rule event settlement', () => {
  it.each(['no request', 'success', 'failure'] as const)('clears pending events after %s', async (path) => {
    const h = stack();
    h.rules.create(ruleInput([ACTION]));
    h.jev.on[URGENCY_FEATURE] = path !== 'no request';
    h.jev.values[URGENCY] = 1;
    h.jev.fail = path === 'failure';
    h.say();
    if (path !== 'no request') expect(h.pending()).toBe(1);
    await vi.waitFor(() => expect(h.settled).toHaveLength(1));
    expect(h.pending()).toBe(0);
    expect(h.settled[0]!.answers === null).toBe(path !== 'success');
    expect(h.settled[0]!.eventId).toBeGreaterThan(0);
  });

  it('settles catch-up and rejudge messages with nothing to ask exactly once', async () => {
    const h = stack();
    const m = h.say();
    const arrivalId = h.settled[0]!.eventId;
    h.settled.length = 0;
    h.rules.create(ruleInput([ACTION], { gates: { missed: true } }));
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ m: { id: m.id }, answers: null });
    expect(h.pending()).toBe(0);
    const catchUpId = h.settled[0]!.eventId;
    h.settled.length = 0;
    await h.matcher.rejudge([m], new Set());
    expect(h.settled).toHaveLength(1);
    expect(h.pending()).toBe(0);
    expect(new Set([arrivalId, catchUpId, h.settled[0]!.eventId]).size).toBe(3);
  });

  it.each([false, true])('clears pending catch-up events when batch failure is %s', async (fail) => {
    const h = stack();
    h.rules.create(ruleInput([ACTION], { gates: { missed: true } }));
    const id = h.rules.create(
      ruleInput([ACTION], { match: { meaning: 'news' }, gates: { missed: true } }),
    );
    h.jev.on.topicMeaning = true;
    h.jev.values[`rule:${id}`] = 1;
    h.jev.fail = fail;
    const m = h.say(false);
    h.matcher.catchUpJudgments();
    expect(h.pending()).toBe(1);
    await vi.waitFor(() => expect(h.settled).toHaveLength(1));
    expect(h.pending()).toBe(0);
    expect(h.settled[0]!.answers === null).toBe(fail);
    const catchUpId = h.settled[0]!.eventId;
    h.settled.length = 0;
    await h.matcher.rejudge([m], new Set([`rule:${id}`]));
    expect(h.settled).toHaveLength(1);
    expect(h.pending()).toBe(0);
    expect(h.settled[0]!.eventId).not.toBe(catchUpId);
    expect(h.settled[0]!.answers === null).toBe(fail);
  });

  it('settles a nested trigger separately while the arrival waits for urgency', async () => {
    const h = stack();
    h.rules.create(ruleInput([ACTION]));
    const nested = ruleInput([ACTION], { gates: { missed: true } });
    h.rules.create({ ...nested, spec: { ...nested.spec, trigger: { type: PROBE_TRIGGER, config: 'yes' } } });
    h.jev.on[URGENCY_FEATURE] = true;
    h.jev.values[URGENCY] = 0;
    const m = h.say();
    expect(h.pending()).toBe(1);
    h.kinds.trigger(PROBE_TRIGGER).fire({ m, liveAt: null, key: 'nested', accepts: () => true });
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]!.answers).toBeNull();
    expect(h.pending()).toBe(1);
    await vi.waitFor(() => expect(h.settled).toHaveLength(2));
    expect(h.pending()).toBe(0);
    expect(new Set(h.settled.map((e) => e.eventId)).size).toBe(2);
  });
});
