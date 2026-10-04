// Channel suggestions: a small sample of recent messages from channels that aren't archived, scored by Jev against
// the owner's rules. Samples are fetched only on request (Browse → Suggest channels) and never stored.
import type { ChannelSample, ChannelSuggestion } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import type { Rule } from '@shared/rules';
import type { DecisionProvider } from './ai/decisions';
import { clipMessage } from './ai/clip';
import { queryMatch, queryRequest } from './jev/queries';

/** Settings → Jev → Queries id; its condition decides when a channel fits what a rule watches for. */
const SUGGEST_QUERY = 'channels.suggest';
const question = (topic: string) => queryRequest(SUGGEST_QUERY, { vars: { topic } });

/** What a rule watches for, in words Jev can match: its meaning, else its name. */
const ruleText = (r: Rule): string =>
  (r.spec.match.find((p) => p.type === 'meaning')?.config as string | undefined) ?? r.name;

/**
 * One Jev request per sampled channel, asking about each of the owner's rules; best matches first. Channels with no match,
 * and `localOnly` channels (Jev is hosted), are left out.
 */
export async function suggestChannels(
  jev: DecisionProvider,
  rules: Rule[],
  samples: ChannelSample[],
  localOnly: ReadonlySet<string>,
): Promise<ChannelSuggestion[]> {
  const mine = rules.filter((r) => r.enabled && !r.builtin && !r.error);
  if (!mine.length) throw new Error('Add a rule first: suggestions match channels against your rules.');
  const out: ChannelSuggestion[] = [];
  for (const s of samples) {
    if (!s.messages.length || localOnly.has(s.channelId)) continue;
    const questions = Object.fromEntries(mine.map((t) => [`t${t.id}`, question(ruleText(t))]));
    const state = { channel: s.channelName, recent: s.messages.map((m) => `${m.author}: ${clipMessage(m.content)}`) };
    try {
      const { answers } = await jev.decide({ state, questions });
      const hits = mine.flatMap((t) => {
        const a = answers[`t${t.id}`];
        const p = a ? queryMatch(SUGGEST_QUERY, a) : null;
        return p !== null ? [{ name: t.name, p }] : [];
      });
      if (hits.length)
        out.push({ channelId: s.channelId, score: Math.max(...hits.map((h) => h.p)), rules: hits.map((h) => h.name) });
    } catch (err) {
      console.warn('[suggest] Jev failed for a channel:', errorMessage(err));
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
