import { beforeEach, describe, expect, it } from 'vitest';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, settleAsync } from './helpers';
import { probeAction, ruleHarness, ruleInput, runsOf, type Harness } from './ruleHarness';

let h: Harness;
beforeEach(() => {
  h = ruleHarness();
});

/** Whether the probe action ran on the message. */
const acted = (messageId: string): boolean =>
  h.probe.runs.some((r) => r.event.kind === 'message' && r.event.m.id === messageId);

describe('rule engine', () => {
  it('fires once per rule and message, however often the message arrives', async () => {
    const id = h.rules.create(ruleInput([probeAction()], { match: { text: { pattern: 'cjj', spec: null } } }));
    const m = h.say('cjj is out');
    h.archive.ingestMessages([m], ARRIVAL.gateway);
    h.archive.ingestMessages([{ ...m, content: 'cjj is out!' }], ARRIVAL.gateway); // an edit
    await settleAsync();
    expect(runsOf(h, id)).toEqual([[m.id, true, ['done']]]);
    expect(h.rules.runs(id, 1)[0]).toMatchObject({ authorName: 'u2', snippet: 'cjj is out!' }); // the message as it reads now
    expect(acted(m.id)).toBe(true);
  });

  it('an edit starts only rules that take edits', async () => {
    const plain = h.rules.create(ruleInput([probeAction()], { match: { text: { pattern: 'late', spec: null } } }));
    const edits = h.rules.create(
      ruleInput([probeAction()], { gates: { edits: true }, match: { text: { pattern: 'late', spec: null } } }),
    );
    const m = h.say('hello');
    h.archive.ingestMessages([{ ...m, content: 'hello, running late' }], ARRIVAL.gateway);
    await settleAsync();
    expect([runsOf(h, plain).length, runsOf(h, edits).length]).toEqual([0, 1]);
  });

  it('acts only on messages sent after it was armed', async () => {
    const before = rawMessage('c1', Date.now() - 1, 'early', { author: { id: 'u2', username: 'u2' } });
    const id = h.rules.create(ruleInput([probeAction()]));
    h.archive.ingestMessages([before], ARRIVAL.gateway);
    await settleAsync();
    expect(runsOf(h, id)).toEqual([]);
  });

  it('every gate and narrowing must hold: author, channel, server, contents and links', async () => {
    const author = '900000000000000009'; // author gates take Discord user ids
    const byAuthor = h.rules.create(ruleInput([probeAction()], { gates: { authorIds: [author] } }));
    const notAuthor = h.rules.create(ruleInput([probeAction()], { gates: { authorIds: [author], authorsNot: true } }));
    const inServer = h.rules.create(ruleInput([probeAction()], { gates: { guildIds: ['g2'] } }));
    const inChannel = h.rules.create(ruleInput([probeAction()], { gates: { channelIds: ['c1'] } }));
    const withLink = h.rules.create(ruleInput([probeAction()], { narrow: { linkPlatforms: ['youtube'] } }));
    const toSite = h.rules.create(ruleInput([probeAction()], { narrow: { linkDomains: ['example.com'] } }));
    const hasLink = h.rules.create(ruleInput([probeAction()], { narrow: { contains: ['link'] } }));
    const a = h.say('from them', { author });
    const b = h.say('see https://www.youtube.com/watch?v=abc', { channel: 'c2' });
    const c = h.say('docs at https://docs.example.com/x');
    await settleAsync();
    const hits = (id: number) => runsOf(h, id).map((r) => r[0]);
    expect(hits(byAuthor)).toEqual([a.id]);
    expect(hits(notAuthor)).toEqual([b.id, c.id]);
    expect(hits(inServer)).toEqual([b.id]);
    expect(hits(inChannel)).toEqual([a.id, c.id]);
    expect(hits(withLink)).toEqual([b.id]);
    expect(hits(toSite)).toEqual([c.id]);
    expect(hits(hasLink)).toEqual([b.id, c.id]);
  });

  it('a missed message starts only rules that take missed ones, and never posts to Discord', async () => {
    const takes = h.rules.create(ruleInput([probeAction()], { gates: { missed: true } }));
    const liveOnly = h.rules.create(ruleInput([probeAction()]));
    const m = h.say('fetched while closed', { via: ARRIVAL.sync });
    await settleAsync();
    expect(runsOf(h, takes)).toEqual([[m.id, false, ['done']]]);
    expect(runsOf(h, liveOnly)).toEqual([]);
  });

  it('one set match field is enough: keywords or a narrowing-only rule', async () => {
    const either = h.rules.create(ruleInput([probeAction()], { match: { text: { pattern: 'alpha', spec: null } } }));
    const everyLink = h.rules.create(ruleInput([probeAction()], { narrow: { contains: ['link'] } }));
    const a = h.say('alpha here');
    const b = h.say('https://example.com/x');
    h.say('nothing');
    await settleAsync();
    expect(runsOf(h, either).map((r) => r[0])).toEqual([a.id]);
    expect(runsOf(h, everyLink).map((r) => r[0])).toEqual([b.id]);
  });
});
