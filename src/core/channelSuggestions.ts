// On-demand Jev channel suggestions sample recent unarchived messages against owner rules. Samples are never stored.
import type { ChannelSample, ChannelSuggestion } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import type { Rule } from '@shared/rules';
import { clipMessage } from './ai/clip';
import { isRefused, refusable, type PluginDecider } from './ai/readScope';
import { queryMatch, queryRequest } from './jev/queries';

/** Settings → Jev → Queries id; its condition decides when a channel fits what a rule watches for. */
const SUGGEST_QUERY = 'channels.suggest';
const question = (topic: string) => queryRequest(SUGGEST_QUERY, { vars: { topic } });

/** What a rule watches for, in words Jev can match: its meaning, else its name. */
const ruleText = (r: Rule): string =>
  (r.spec.match.find((p) => p.type === 'meaning')?.config as string | undefined) ?? r.name;

/**
 * One Jev request per sampled channel, asking about each of the owner's rules; best matches first. Channels with no match,
 * and local-AI-only ones (Jev is hosted; checked as each request is sent), are left out.
 */
export async function suggestChannels(jev: PluginDecider, rules: Rule[], samples: ChannelSample[]): Promise<ChannelSuggestion[]> {
  const mine = rules.filter((r) => r.enabled && !r.builtin && !r.error);
  if (!mine.length) throw new Error('Add a rule first: suggestions match channels against your rules.');
  const out: ChannelSuggestion[] = [];
  for (const s of samples) {
    if (!s.messages.length) continue;
    const questions = Object.fromEntries(mine.map((t) => [`t${t.id}`, question(ruleText(t))]));
    const state = { channel: s.channelName, recent: s.messages.map((m) => `${m.author}: ${clipMessage(m.content)}`) };
    try {
      const r = await refusable(jev.decide({ state, questions, reads: [s.channelId] }));
      // A local-only channel is left out, not a failure.
      if (isRefused(r)) continue;
      const { answers } = r;
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
