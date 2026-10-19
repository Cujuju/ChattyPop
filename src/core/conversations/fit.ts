// Fits the chooser to the archive's own Discord replies it would decide (no rule applies, the target is a candidate); keeps the fit in settings.
import { getSetting, setSetting, type Db } from '../db';
import { DEFAULT_WEIGHTS, fitSample, fitWeights, type FitSample, type Weights } from './chooser';
import { FEATURE_COUNT } from './features';
import { CANDIDATE_MAX, ruleLink } from './linker';
import { channelReach, contextInputs, messageInput, storedReplies } from './store';

/** Newest replies fitted: a dozen weights need far fewer, and newer replies follow how the community talks now. */
export const FIT_SAMPLE = 2_000;
/** Fewer examples than this keep the default weights (about forty per weight). */
export const FIT_MIN_REPLIES = 500;
/** Refit once the stored replies have doubled since the last fit: each refit relinks the archive, so refits stay logarithmic in its size. */
export const REFIT_GROWTH = 2;
export const CHOOSER_KEY = 'conversations.chooser';
/** Samples gathered per synchronous step before yielding. */
const SAMPLE_BATCH = 100;

export interface StoredChooser {
  weights: number[];
  /** Stored replies when it was fitted. */
  replies: number;
  /** The linker version it was fitted for (features change with it). */
  linkerVersion: number;
  /** The oldest fitted reply's time: replies before it were never in the sample, so the judge calibrates on them. Absent before #314. */
  sampleFromTs?: number;
}

export function storedChooser(db: Db, linkerVersion: number): StoredChooser | undefined {
  const value = getSetting(db, CHOOSER_KEY) as StoredChooser | undefined;
  return value?.linkerVersion === linkerVersion && value.weights.length === FEATURE_COUNT ? value : undefined;
}

export const saveChooser = (db: Db, chooser: StoredChooser): void => setSetting(db, CHOOSER_KEY, chooser);

/** The weights linking uses now: the archive's fit, else the defaults. */
export const chooserWeights = (db: Db, linkerVersion: number): Weights => storedChooser(db, linkerVersion)?.weights ?? DEFAULT_WEIGHTS;

/** Training examples from the newest stored replies that `include` accepts (all by default). */
export async function replySamples(db: Db, include: (id: string) => boolean = () => true, signal?: AbortSignal): Promise<FitSample[]> {
  return (await sampledReplies(db, include, signal)).samples;
}

/** replySamples, with the oldest reply time it read (undefined with none). */
export async function sampledReplies(
  db: Db, include: (id: string) => boolean = () => true, signal?: AbortSignal,
): Promise<{ samples: FitSample[]; fromTs: number | undefined }> {
  const replies = storedReplies(db).filter((r) => include(r.id)).slice(0, FIT_SAMPLE);
  const reach = new Map<string, number>();
  const samples: FitSample[] = [];
  for (let i = 0; i < replies.length; i++) {
    if (i % SAMPLE_BATCH === 0) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const r = replies[i]!;
    const m = messageInput(db, r.id);
    if (!m) continue;
    if (!reach.has(r.channelId)) reach.set(r.channelId, channelReach(db, r.channelId));
    const candidates = contextInputs(db, r.channelId, m, reach.get(r.channelId)!, CANDIDATE_MAX);
    const index = candidates.findIndex((c) => c.id === r.parentId);
    // A reply beyond the candidates, or one a rule decides, says nothing about how the chooser should rank them.
    if (index >= 0 && !ruleLink(m, candidates)) samples.push(fitSample(m, candidates, index));
  }
  return { samples, fromTs: replies.at(-1)?.ts };
}

/** Weights fitted to `samples`, or the defaults when there are too few. */
export const fittedWeights = (samples: readonly FitSample[]): Weights =>
  samples.length >= FIT_MIN_REPLIES ? fitWeights(samples) : DEFAULT_WEIGHTS;
