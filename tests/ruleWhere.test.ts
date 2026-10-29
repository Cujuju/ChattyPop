// A rule's Where is a union of places: every channel of a picked server plus each picked channel, alike for message
// gates, direct history, timed windows and the keyword editor's archive check.
import { describe, expect, it } from 'vitest';
import { GUILD_TEXT_CHANNEL_TYPE } from '@shared/discord';
import { previewPattern } from '../src/core/patternPreview';
import { readHistory } from '../src/core/rules/history';
import { scopeChannels } from '../src/core/rules/schedule';
import { settleAsync } from './helpers';
import { probeAction, ruleHarness, ruleInput, runsOf } from './ruleHarness';

describe('a Where with servers and channels', () => {
  it('covers the servers’ channels and the channels, in messages, history, timed windows and the archive check', async () => {
    const h = ruleHarness(); // c1 in server g1, c2 in g2
    h.archive.upsertChannels('g1', [{ id: 'c3', name: 'c3', type: GUILD_TEXT_CHANNEL_TYPE }]);
    h.archive.setOptIn('c3', true);
    const rule = (guildIds: string[], channelIds: string[]) =>
      h.rules.create(ruleInput([probeAction()], { gates: { guildIds, channelIds }, match: { text: { pattern: 'news', spec: null } } }));
    const otherServersChannel = rule(['g1'], ['c2']);
    const ownChannel = rule(['g1'], ['c1']);
    const byChannel = new Map(['c1', 'c2', 'c3'].map((c) => [c, h.say('news', { channel: c }).id]));
    await settleAsync();
    const ids = (channels: string[]) => channels.map((c) => byChannel.get(c)!).sort();

    expect(runsOf(h, otherServersChannel).map((r) => r[0]).sort()).toEqual(ids(['c1', 'c2', 'c3']));
    expect(runsOf(h, ownChannel).map((r) => r[0]).sort()).toEqual(ids(['c1', 'c3']));

    const compiled = (id: number) => h.engine.find(id)!;
    expect(scopeChannels(h.db, compiled(otherServersChannel))!.sort()).toEqual(['c1', 'c2', 'c3']);
    expect(scopeChannels(h.db, compiled(ownChannel))!.sort()).toEqual(['c1', 'c3']);

    const history = (id: number) => readHistory(h.db, compiled(id), h.engine.facts, probeAction().type).matches().map((x) => x.m.id).sort();
    expect(history(otherServersChannel)).toEqual(ids(['c1', 'c2', 'c3']));
    expect(history(ownChannel)).toEqual(ids(['c1', 'c3']));

    const preview = (id: number) => previewPattern(h.db, 'news', compiled(id).spec.gates, null).hits.map((x) => x.messageId).sort();
    expect(preview(otherServersChannel)).toEqual(ids(['c1', 'c2', 'c3']));
    expect(preview(ownChannel)).toEqual(ids(['c1', 'c3']));
  });

  it('still narrows to the picked places alone', async () => {
    const h = ruleHarness();
    const server = h.rules.create(ruleInput([probeAction()], { gates: { guildIds: ['g2'] } }));
    const channel = h.rules.create(ruleInput([probeAction()], { gates: { channelIds: ['c1'] } }));
    const a = h.say('in c1');
    const b = h.say('in c2', { channel: 'c2' });
    await settleAsync();
    expect(runsOf(h, server).map((r) => r[0])).toEqual([b.id]);
    expect(runsOf(h, channel).map((r) => r[0])).toEqual([a.id]);
  });
});
