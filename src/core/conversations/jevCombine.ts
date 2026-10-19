// Combines the chooser with Jev's answers: a softmax over candidates with one weight per signal, fitted by the chooser's fitter.
import { fitWeights, type FitSample, type Weights } from './chooser';

/** Keeps logs finite for a zero probability; far below any probability that decides a pick. */
const PROBABILITY_FLOOR = 1e-6;
/** The signals per candidate, in row order. */
export const COMBINED_SIGNALS = ['chooser', 'level', 'top'] as const;
/** The prior: the chooser alone, so Jev's signals earn their weight from the data. */
const CHOOSER_ONLY: Weights = [1, 0, 0];

/** One case: per candidate (oldest first), the chooser's probability, Jev's Score position (0–1) and its top level's probability. */
export interface CombinedCase { chooser: ArrayLike<number>; level: readonly number[]; top: readonly number[]; target: number }

const clamp = (p: number): number => Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, p));

/** Per candidate: the chooser's log probability, the Score position's log-odds and the top level's log probability. */
function rows(c: CombinedCase): Float64Array {
  const width = COMBINED_SIGNALS.length;
  const r = new Float64Array(c.chooser.length * width);
  for (let j = 0; j < c.chooser.length; j++) {
    const level = clamp(c.level[j]!);
    r[j * width] = Math.log(clamp(c.chooser[j]!));
    r[j * width + 1] = Math.log(level / (1 - level));
    r[j * width + 2] = Math.log(clamp(c.top[j]!));
  }
  return r;
}

export const argmax = (xs: ArrayLike<number>): number => {
  let best = 0;
  for (let j = 1; j < xs.length; j++) if (xs[j]! > xs[best]!) best = j;
  return best;
};

export const fitCombined = (cases: readonly CombinedCase[]): number[] =>
  fitWeights(cases.map((c): FitSample => ({ rows: rows(c), count: c.chooser.length, label: c.target })), CHOOSER_ONLY);

/** The candidate the combination ranks first. */
export function combinedPick(c: CombinedCase, w: Weights): number {
  const r = rows(c);
  const width = w.length;
  const scores = Array.from({ length: c.chooser.length }, (_, j) => w.reduce((s, wk, k) => s + wk * r[j * width + k]!, 0));
  return argmax(scores);
}

/** Each case's combined pick by weights fitted on the other half (alternate cases), so no case is scored by weights fitted on it. */
export function crossFittedPicks(cases: readonly CombinedCase[]): number[] {
  const halves = [0, 1].map((h) => fitCombined(cases.filter((_, i) => i % 2 === h)));
  return cases.map((c, i) => combinedPick(c, halves[1 - (i % 2)]!));
}
