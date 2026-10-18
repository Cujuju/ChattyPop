// Ranks a message's candidate parents: a softmax over linear scores, fitted to the archive's own Discord replies.
import { candidateFeatures, FEATURE_COUNT, type ChooserMessage } from './features';

export type Weights = readonly number[];

/** Before an archive has enough replies of its own: weights (in FEATURES order) fitted on a large community archive's replies. */
export const DEFAULT_WEIGHTS: Weights = [-0.58, 0.07, -2.18, 0.21, 2.7, -0.08, 1.93, 0.38, 0.33, 1.08, -1.56];

export interface Choice {
  /** Index into the candidates. */
  index: number;
  /** The chooser's probability that it is the parent, given that one of the candidates is. */
  probability: number;
}

/** Fills `p` with the softmax over `count` rows of `rows`. */
function softmax(rows: Float64Array, count: number, w: Weights, p: Float64Array): void {
  let max = -Infinity;
  for (let j = 0; j < count; j++) {
    let s = 0;
    for (let k = 0; k < FEATURE_COUNT; k++) s += w[k]! * rows[j * FEATURE_COUNT + k]!;
    p[j] = s;
    if (s > max) max = s;
  }
  let sum = 0;
  for (let j = 0; j < count; j++) sum += p[j] = Math.exp(p[j]! - max);
  for (let j = 0; j < count; j++) p[j]! /= sum;
}

/** Each candidate's probability of being the parent of `m`, given one of them is (same order as `candidates`). */
export function probabilities(m: ChooserMessage, candidates: readonly ChooserMessage[], w: Weights): Float64Array {
  const { rows, count } = fitSample(m, candidates, 0);
  const p = new Float64Array(count);
  softmax(rows, count, w, p);
  return p;
}

/** The most probable parent of `m` among `candidates` (oldest first, at least one). */
export function choose(m: ChooserMessage, candidates: readonly ChooserMessage[], w: Weights): Choice {
  const p = probabilities(m, candidates, w);
  const count = p.length;
  let best = 0;
  for (let j = 1; j < count; j++) if (p[j]! > p[best]!) best = j;
  return { index: best, probability: p[best]! };
}

/** One training example: its candidates' rows and which is the parent. */
export interface FitSample { rows: Float64Array; count: number; label: number }

export function fitSample(m: ChooserMessage, candidates: readonly ChooserMessage[], parentIndex: number): FitSample {
  const rows = new Float64Array(candidates.length * FEATURE_COUNT);
  candidateFeatures(m, candidates, rows);
  return { rows, count: candidates.length, label: parentIndex };
}

/** Pull toward the prior, worth about one reply: data outweighs it, but a feature that never varies keeps its prior weight. */
export const PRIOR_STRENGTH = 1;
/** Newton steps; the fit usually settles in under ten. */
export const FIT_STEPS_MAX = 50;
/** Stop when a step improves the average loss by less than this. */
export const FIT_TOLERANCE = 1e-9;
/** Halvings of a step that would raise the loss before giving up. */
const LINE_SEARCH_MAX = 30;

/** Maximum a-posteriori fit (log-loss plus a Gaussian prior around `prior`), by Newton's method with a backtracking line search. */
export function fitWeights(samples: readonly FitSample[], prior: Weights = DEFAULT_WEIGHTS): number[] {
  let w = [...prior];
  let current = loss(samples, w, prior);
  for (let step = 0; step < FIT_STEPS_MAX && samples.length; step++) {
    const { gradient, hessian } = derivatives(samples, w, prior);
    const delta = solveSpd(hessian, gradient);
    let scale = 1;
    let next = w;
    let nextLoss = Infinity;
    for (let tries = 0; tries < LINE_SEARCH_MAX; tries++, scale /= 2) {
      next = w.map((v, k) => v - scale * delta[k]!);
      nextLoss = loss(samples, next, prior);
      if (nextLoss <= current) break;
    }
    if (!(nextLoss <= current)) break;
    const gain = (current - nextLoss) / samples.length;
    w = next;
    current = nextLoss;
    if (gain < FIT_TOLERANCE) break;
  }
  return w;
}

function loss(samples: readonly FitSample[], w: Weights, prior: Weights): number {
  let total = 0;
  const p = new Float64Array(maxCount(samples));
  for (const s of samples) {
    softmax(s.rows, s.count, w, p);
    total -= Math.log(Math.max(p[s.label]!, Number.MIN_VALUE));
  }
  for (let k = 0; k < FEATURE_COUNT; k++) total += (PRIOR_STRENGTH / 2) * (w[k]! - prior[k]!) ** 2;
  return total;
}

function derivatives(samples: readonly FitSample[], w: Weights, prior: Weights): { gradient: number[]; hessian: number[][] } {
  const gradient = w.map((v, k) => PRIOR_STRENGTH * (v - prior[k]!));
  const hessian = gradient.map((_, i) => gradient.map((__, j) => (i === j ? PRIOR_STRENGTH : 0)));
  const p = new Float64Array(maxCount(samples));
  const mean = new Float64Array(FEATURE_COUNT);
  for (const s of samples) {
    softmax(s.rows, s.count, w, p);
    mean.fill(0);
    for (let j = 0; j < s.count; j++) {
      const row = j * FEATURE_COUNT;
      for (let a = 0; a < FEATURE_COUNT; a++) {
        const xa = s.rows[row + a]!;
        if (!xa) continue;
        mean[a]! += p[j]! * xa;
        for (let b = 0; b < FEATURE_COUNT; b++) hessian[a]![b]! += p[j]! * xa * s.rows[row + b]!;
      }
    }
    const label = s.label * FEATURE_COUNT;
    for (let a = 0; a < FEATURE_COUNT; a++) {
      gradient[a]! += mean[a]! - s.rows[label + a]!;
      for (let b = 0; b < FEATURE_COUNT; b++) hessian[a]![b]! -= mean[a]! * mean[b]!;
    }
  }
  return { gradient, hessian };
}

const maxCount = (samples: readonly FitSample[]): number => samples.reduce((n, s) => Math.max(n, s.count), 1);

/** Solves A x = b for a symmetric positive-definite A (the prior keeps the Hessian so), by Cholesky. */
function solveSpd(a: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const l = a.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i]![j]!;
      for (let k = 0; k < j; k++) s -= l[i]![k]! * l[j]![k]!;
      l[i]![j] = i === j ? Math.sqrt(Math.max(s, Number.MIN_VALUE)) : s / l[j]![j]!;
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= l[i]![k]! * y[k]!;
    y[i] = s / l[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k]![i]! * x[k]!;
    x[i] = s / l[i]![i]!;
  }
  return x;
}
