// Measures Jev against the chooser on held-out Discord replies decided as if unmarked, by the chooser's confidence.
import type { JevBucketScore, JevConfidenceScore, JevLinkScore } from '@shared/conversationScore';
import { errorMessage } from '@shared/errors';
import { sumCosts, type DecisionProvider } from '../ai/decisions';
import { assertHostedMayRead, localOnlyChannelIds } from '../channelPolicy';
import type { Db } from '../db';
import { askedMessages, askParent, isAnswered, type JevView } from './ask';
import { probabilities } from './chooser';
import { fittedWeights, replySamples } from './fit';
import { argmax, COMBINED_SIGNALS, crossFittedPicks, fitCombined, type CombinedCase } from './jevCombine';
import { CANDIDATE_MAX, ruleLink } from './linker';
import { isHeldOut } from './score';
import { channelReach, contextInputs, messageInput, storedReplies } from './store';

/** Confidence bands compared (the chooser's, then Jev's), edges ascending: the link level (0.3) and even odds (0.5) among them. */
export const JEV_SCORE_BANDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1] as const;
/** Held-out replies asked about per band: seven bands of fifty is at most 350 requests, each one message's questions. */
export const JEV_SCORE_PER_BAND = 50;
/** Held-out replies examined at most: a band rare in this archive stays short instead of the scan reading every reply. */
export const JEV_SCORE_SCAN_MAX = 10_000;
/** At or above this a yes/no answer leans yes. */
const EVEN_ODDS = 0.5;

interface Case { channelId: string; message: string; candidates: string[]; target: number; chooser: Float64Array; band: number }

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
    const chooser = probabilities(m, candidates, weights);
    const band = bandOf(chooser[argmax(chooser)]!);
    if (counts[band]! >= perBand) continue;
    counts[band]!++;
    found.push({ channelId: r.channelId, message: m.id, candidates: candidates.map((c) => c.id), target, chooser, band });
  }
  return { cases: found, outOfReach };
}


export interface JevScoreOptions {
  perBand?: number;
  /** A Jev release to ask instead of the pinned one. */
  release?: string;
  signal?: AbortSignal;
}

/** Jev's views, one per case (null when the request failed), failures with the first one's error, and the request costs. */
async function ask(db: Db, jev: DecisionProvider, found: readonly Case[], release?: string, signal?: AbortSignal) {
  const texts = askedMessages(db, found.flatMap((c) => [c.message, ...c.candidates]));
  const costs: number[] = [];
  let failed = 0;
  let failure: string | null = null;
  const views = await Promise.all(found.map(async (c): Promise<JevView | null> => {
    try {
      const admit = () => assertHostedMayRead(db, c.channelId);
      const { view, costUsd } = await askParent(jev, texts.get(c.message)!, c.candidates.map((id) => texts.get(id)!), { admit, signal, release });
      if (costUsd !== null) costs.push(costUsd);
      return view;
    } catch (err) {
      signal?.throwIfAborted();
      failed++;
      failure ??= errorMessage(err);
      console.warn('[conversations] Jev score request failed', err);
      return null;
    }
  }));
  return { views, failed, failure, costUsd: sumCosts(costs) };
}

const emptyBands = <T>(row: (from: number, to: number) => T): T[] => JEV_SCORE_BANDS.slice(0, -1).map((from, i) => row(from, JEV_SCORE_BANDS[i + 1]!));

/** Asks Jev about each case; the chooser is fitted on the other half of the replies, as the link score does. */
export async function scoreJevOnReplies(db: Db, jev: DecisionProvider, opts: JevScoreOptions = {}): Promise<JevLinkScore> {
  const { perBand = JEV_SCORE_PER_BAND, release, signal } = opts;
  const weights = fittedWeights(await replySamples(db, (id) => !isHeldOut(id), signal));
  const { cases: found, outOfReach } = cases(db, perBand, weights);
  const { views, failed, failure, costUsd } = await ask(db, jev, found, release, signal);
  const answered = found.flatMap((c, i) => { const v = views[i]!; return isAnswered(v) ? [{ c, v }] : []; });
  const combined: CombinedCase[] = answered.map(({ c, v }) => ({
    chooser: c.chooser, level: v.relates.map((r) => r.level), top: v.relates.map((r) => r.top), target: c.target,
  }));
  const combinedPicks = crossFittedPicks(combined);
  const bands: JevBucketScore[] = emptyBands((from, to) => ({ from, to, asked: 0, answered: 0, chooserExact: 0, relatesExact: 0, combinedExact: 0, respondsYes: 0 }));
  const byJevConfidence: JevConfidenceScore[] = emptyBands((from, to) => ({ from, to, asked: 0, exact: 0 }));
  const discordant = { chooserOnly: 0, combinedOnly: 0 };
  for (const c of found) {
    bands[c.band]!.asked++;
    if (argmax(c.chooser) === c.target) bands[c.band]!.chooserExact++;
  }
  answered.forEach(({ c, v }, k) => {
    const b = bands[c.band]!;
    b.answered++;
    const best = argmax(combined[k]!.level);
    if (best === c.target) b.relatesExact++;
    if (combinedPicks[k] === c.target) b.combinedExact++;
    const chooserRight = argmax(c.chooser) === c.target;
    if (chooserRight !== (combinedPicks[k] === c.target)) discordant[chooserRight ? 'chooserOnly' : 'combinedOnly']++;
    if (v.responds >= EVEN_ODDS) b.respondsYes++;
    const conf = byJevConfidence[bandOf(v.relates[best]!.top)]!;
    conf.asked++;
    if (best === c.target) conf.exact++;
  });
  const w = fitCombined(combined);
  return {
    model: release ?? jev.model,
    bands,
    byJevConfidence,
    combinedWeights: Object.fromEntries(COMBINED_SIGNALS.map((name, k) => [name, w[k]!])),
    discordant,
    failed,
    failure,
    outOfReach,
    costUsd,
  };
}
