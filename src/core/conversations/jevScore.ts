// Measures Jev against the chooser on held-out Discord replies decided as if unmarked, by the chooser's confidence.
import type { JevBucketScore, JevLinkScore } from '@shared/conversationScore';
import { sumCosts, type DecisionProvider } from '../ai/decisions';
import { assertHostedMayRead, localOnlyChannelIds } from '../channelPolicy';
import type { Db } from '../db';
import { askedMessages, askParent } from './ask';
import { probabilities } from './chooser';
import { fittedWeights, replySamples } from './fit';
import { CANDIDATE_MAX, ruleLink } from './linker';
import { isHeldOut } from './score';
import { channelReach, contextInputs, messageInput, storedReplies } from './store';

/** Chooser confidence bands compared, edges ascending: the link level (0.3) and even odds (0.5) among them. */
export const JEV_SCORE_BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1] as const;
/** Held-out replies asked about per band: seven bands of fifty is at most 350 requests, about two cents at Jev's price. */
export const JEV_SCORE_PER_BAND = 50;
/** Held-out replies examined at most: a band rare in this archive stays short instead of the scan reading every reply. */
export const JEV_SCORE_SCAN_MAX = 10_000;

interface Case { channelId: string; message: string; candidates: string[]; target: string; chooserPick: string; band: number }

const bandOf = (p: number): number => {
  for (let b = JEV_SCORE_BANDS.length - 2; b >= 0; b--) if (p >= JEV_SCORE_BANDS[b]!) return b;
  return 0;
};

/** Newest held-out replies the chooser would decide (Jev sees all its candidates, oldest first), in channels hosted AI may read, up to `perBand` per band. */
function cases(db: Db, perBand: number, weights: readonly number[]): { cases: Case[]; outOfReach: number } {
  const localOnly = localOnlyChannelIds(db);
  const counts = new Array<number>(JEV_SCORE_BANDS.length - 1).fill(0);
  const found: Case[] = [];
  const reach = new Map<string, number>();
  let outOfReach = 0;
  let examined = 0;
  for (const r of storedReplies(db)) {
    if (counts.every((n) => n >= perBand) || examined >= JEV_SCORE_SCAN_MAX) break;
    if (!isHeldOut(r.id) || localOnly.has(r.channelId)) continue;
    examined++;
    const m = messageInput(db, r.id);
    if (!m) continue;
    if (!reach.has(r.channelId)) reach.set(r.channelId, channelReach(db, r.channelId));
    const candidates = contextInputs(db, r.channelId, m, reach.get(r.channelId)!, CANDIDATE_MAX);
    if (!candidates.length || ruleLink(m, candidates)) continue;
    const target = candidates.findIndex((c) => c.id === r.parentId);
    if (target < 0) { outOfReach++; continue; }
    const p = probabilities(m, candidates, weights);
    const order = [...p.keys()].sort((a, b) => p[b]! - p[a]!);
    const band = bandOf(p[order[0]!]!);
    if (counts[band]! >= perBand) continue;
    counts[band]!++;
    found.push({ channelId: r.channelId, message: m.id, candidates: candidates.map((c) => c.id), target: r.parentId,
      chooserPick: candidates[order[0]!]!.id, band });
  }
  return { cases: found, outOfReach };
}

/** Asks Jev about each case; the chooser is fitted on the other half of the replies, as the link score does. */
export async function scoreJevOnReplies(db: Db, jev: DecisionProvider, perBand = JEV_SCORE_PER_BAND, signal?: AbortSignal): Promise<JevLinkScore> {
  const weights = fittedWeights(await replySamples(db, (id) => !isHeldOut(id), signal));
  const { cases: found, outOfReach } = cases(db, perBand, weights);
  const texts = askedMessages(db, found.flatMap((c) => [c.message, ...c.candidates]));
  const bands: JevBucketScore[] = JEV_SCORE_BANDS.slice(0, -1).map((from, i) => ({
    from, to: JEV_SCORE_BANDS[i + 1]!, asked: 0, answered: 0, chooserExact: 0, jevExact: 0, jevLinks: 0, jevLinksExact: 0, jevNone: 0,
  }));
  const costs: number[] = [];
  let failed = 0;
  await Promise.all(found.map(async (c) => {
    const b = bands[c.band]!;
    b.asked++;
    if (c.chooserPick === c.target) b.chooserExact++;
    try {
      const { pick, costUsd } = await askParent(jev, texts.get(c.message)!, c.candidates.map((id) => texts.get(id)!), () => assertHostedMayRead(db, c.channelId), signal);
      if (costUsd !== null) costs.push(costUsd);
      if (!pick) return;
      b.answered++;
      if (pick.parentId === c.target) b.jevExact++;
      if (pick.parentId === null) b.jevNone++;
      if (pick.links) { b.jevLinks++; if (pick.parentId === c.target) b.jevLinksExact++; }
    } catch (err) {
      signal?.throwIfAborted();
      failed++;
      console.warn('[conversations] Jev score request failed', err);
    }
  }));
  return { bands, failed, outOfReach, costUsd: sumCosts(costs) };
}
