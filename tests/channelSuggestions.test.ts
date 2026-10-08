import { describe, expect, it } from 'vitest';
import type { Rule } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';
import { suggestChannels } from '../src/core/channelSuggestions';
import { FakeJev } from './fakeJev';

const rule = (id: number, name: string, extra: Partial<Rule> = {}): Rule => ({
  ...newRuleInput(),
  id,
  name,
  position: id,
  armedAt: 0,
  createdAt: 0,
  builtin: null,
  group: null,
  error: null,
  fired: 0,
  lastFiredAt: null,
  ...extra,
});

describe('channel suggestions', () => {
  it('suggests channels whose sample matches a rule, best first, and skips empty samples', async () => {
    const channelOf = (state: unknown): string => (state as { channel: string }).channel;
    const jev = new FakeJev((req) => {
      const ch = channelOf(req.state);
      const p = ch === 'games' ? 0.9 : ch === 'offtopic' ? 0.65 : 0.1;
      return { t1: { type: 'noul', noul: p }, t9: { type: 'noul', noul: 0.99 } };
    });
    const rules = [rule(1, 'gaming'), rule(9, 'Aimed at you', { builtin: 'aimed_at_me' }), rule(2, 'off', { enabled: false })];
    const samples = [
      { channelId: 'a', channelName: 'offtopic', messages: [{ author: 'x', content: 'anyone playing?' }] },
      { channelId: 'b', channelName: 'games', messages: [{ author: 'y', content: 'new patch' }] },
      { channelId: 'c', channelName: 'art', messages: [{ author: 'z', content: 'sketch' }] },
      { channelId: 'd', channelName: 'empty', messages: [] },
    ];
    const out = await suggestChannels(jev, rules, samples, new Set());
    expect(out).toEqual([
      { channelId: 'b', score: 0.9, rules: ['gaming'] },
      { channelId: 'a', score: 0.65, rules: ['gaming'] },
    ]);
    expect(jev.requests.map((r) => channelOf(r.state))).toEqual(['offtopic', 'games', 'art']);
  });

  it('never samples a local-AI-only channel to Jev', async () => {
    const jev = new FakeJev(() => ({ t1: { type: 'noul', noul: 0.9 } }));
    const samples = [
      { channelId: 'open', channelName: 'games', messages: [{ author: 'x', content: 'new patch' }] },
      { channelId: 'private', channelName: 'family', messages: [{ author: 'y', content: 'private plans' }] },
    ];
    const out = await suggestChannels(jev, [rule(1, 'gaming')], samples, new Set(['private']));
    expect(out.map((s) => s.channelId)).toEqual(['open']);
    expect(JSON.stringify(jev.requests)).not.toContain('private plans');
  });

  it('asks for a rule first when the owner has none', async () => {
    await expect(suggestChannels(new FakeJev(), [], [], new Set())).rejects.toThrow(/Add a rule first/);
  });
});
