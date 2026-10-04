// Host jev.
import { sleep } from '@shared/async';
import { errorMessage } from '@shared/errors';
import { JEV_MODEL, type OpenRouterKeyEntry } from '@shared/openrouter';
import { MS_PER_S } from '@shared/units';
import type { DecisionProvider, DecisionRequest, DecisionResult, Question } from './decisions';
import { OPENROUTER_API } from '@shared/openrouter';
import { OPENROUTER_APP_HEADERS, openRouterErrorText, type OpenRouterError } from './openRouterKeys';

/** OpenRouter's System One surface: TypeSafe's request/response shapes, billed to the OpenRouter key. */
const OPENROUTER_ENDPOINT = `${OPENROUTER_API}/systemone`;
/** TypeSafe's own System One endpoint (docs.typesafe.ai/api), billed to the TypeSafe account. */
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** TypeSafe's versioned id for the release OpenRouter calls jev-1.13 (docs.typesafe.ai/models). */
const TYPESAFE_WIRE_MODEL = `${JEV_MODEL}.0`;
const TOKENS_PER_MILLION = 1_000_000;
/** TypeSafe's published input price, $0.042 per million tokens; output is free. TypeSafe reports tokens, not cost. */
const TYPESAFE_USD_PER_INPUT_TOKEN = 0.042 / TOKENS_PER_MILLION;
/** TypeSafe answers an unknown key with 401 and a missing one with 403. */
const TYPESAFE_REJECTED = new Set([401, 403]);
/** jev-1.13 context window. */
const CONTEXT_TOKENS = 32_000;
/** Conservative for emoji, code and non-English text, which tokenize worse than prose. */
const CHARS_PER_TOKEN_LOW = 2;
/** Documented latency is 70–500 ms; this only bounds a hung request. */
const REQUEST_TIMEOUT_MS = 15_000;
/** TypeSafe asks clients to back off on 429 (rate limit) and 529 (overloaded). */
const RETRY_STATUSES = new Set([429, 529]);
/** Three tries keep a delayed live alert within a few seconds. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
/** Bounds a backfill burst so interactive requests aren't queued behind it and 429s stay rare. */
const MAX_IN_FLIGHT = 4;

/** Jev rejects a whole request over one lone surrogate (half an emoji), so any that slips past cutText becomes U+FFFD. */
const wellFormed = (_key: string, v: unknown): unknown => (typeof v === 'string' ? v.toWellFormed() : v);

export interface SystemOneResponse {
  answers?: Record<string, unknown>;
  usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
  error?: OpenRouterError | string;
  detail?: unknown;
}

export interface JevTokens {
  input: number;
  output: number;
}
/** One answered request: questions asked, price and tokens (null when the service didn't report them). */
export type JevSpent = (questions: number, usd: number | null, tokens: JevTokens | null) => void;

/** Where a Jev request goes and who pays: an OpenRouter key that lists Jev, or a TypeSafe key. */
export interface JevRoute {
  /** Who pays, as Settings shows it. */
  label: string;
  endpoint: string;
  /** This endpoint's id for the pinned release. */
  wireModel: string;
  headers: Record<string, string>;
  /** Error text from a failed response. */
  errorText(json: SystemOneResponse, status: number): string;
  /** USD for an answered request: the reported cost, else one computed from tokens; null when neither is known. */
  cost(usage: SystemOneResponse['usage']): number | null;
}

export function openRouterJevRoute(k: OpenRouterKeyEntry): JevRoute {
  return {
    label: k.label,
    endpoint: OPENROUTER_ENDPOINT,
    wireModel: JEV_MODEL,
    headers: { authorization: `Bearer ${k.key}`, ...OPENROUTER_APP_HEADERS },
    errorText: (json, status) =>
      typeof json.error === 'string' ? json.error : json.error || !json.detail ? openRouterErrorText(json.error, status, k.label) : JSON.stringify(json.detail),
    cost: (u) => (typeof u?.cost === 'number' ? u.cost : null),
  };
}

export function typeSafeJevRoute(key: string): JevRoute {
  return {
    label: 'TypeSafe',
    endpoint: TYPESAFE_ENDPOINT,
    wireModel: TYPESAFE_WIRE_MODEL,
    headers: { authorization: `Bearer ${key}` },
    errorText: (json, status) => {
      if (TYPESAFE_REJECTED.has(status)) return 'TypeSafe rejected the key. Check it in Settings → Jev.';
      const d = json.detail as { message?: unknown } | undefined;
      return `TypeSafe: ${typeof d?.message === 'string' ? d.message : d ? JSON.stringify(d) : `HTTP ${status}`}`;
    },
    cost: (u) => (typeof u?.cost === 'number' ? u.cost : typeof u?.input_tokens === 'number' ? u.input_tokens * TYPESAFE_USD_PER_INPUT_TOKEN : null),
  };
}

const isProb = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** Drops malformed answers, so callers can rely on "present = well-formed, absent = no judgment". */
function isAnswerTo(q: Question, a: unknown): boolean {
  if (typeof a !== 'object' || a === null) return false;
  const r = a as Record<string, unknown>;
  if (r['type'] !== q.type) return false;
  switch (q.type) {
    case 'noul':
      return isProb(r['noul']);
    case 'choice':
      return typeof r['choice'] === 'string' && r['choice'] in q.criteria && isProb(r['confidence']);
    case 'score':
      return typeof r['score'] === 'number' && Number.isFinite(r['score']) && isProb(r['confidence']);
  }
}

/**
 * Jev over any route (OpenRouter or TypeSafe). One shared instance, so the in-flight cap is global.
 * `model` names the release, the same on every route, so stored judgments and thresholds carry across.
 */
export class JevProvider {
  readonly model = JEV_MODEL;
  /** @param spent every answered request: its question count, price and tokens (each null when unknown). */
  constructor(private readonly spent: JevSpent) {}

  readonly maxInputChars = CONTEXT_TOKENS * CHARS_PER_TOKEN_LOW;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  /** Most recent failure, for Settings; cleared by the next success. */
  lastError: { message: string; at: number } | null = null;

  /** A decision provider sending every request over `route`. */
  via(route: JevRoute): DecisionProvider {
    return { model: this.model, maxInputChars: this.maxInputChars, decide: (req) => this.decide(route, req) };
  }

  private async decide<Q extends Record<string, Question>>(route: JevRoute, req: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    await this.acquire();
    try {
      // Cancelled while it waited for a slot (its plugin turned off): never sent, never paid for.
      req.signal?.throwIfAborted();
      const { result, tokens } = await this.post(route, req);
      this.lastError = null;
      this.spent(Object.keys(req.questions).length, result.costUsd, tokens);
      return result;
    } catch (err) {
      // A cancel is the caller's choice, not Jev failing.
      if (!req.signal?.aborted) this.lastError = { message: errorMessage(err), at: Date.now() };
      throw err;
    } finally {
      this.release();
    }
  }

  private async post<Q extends Record<string, Question>>(route: JevRoute, req: DecisionRequest<Q>): Promise<{ result: DecisionResult<Q>; tokens: JevTokens | null }> {
    const body = JSON.stringify({ model: route.wireModel, state: req.state, questions: req.questions }, wellFormed);
    for (let attempt = 1; ; attempt++) {
      req.admit?.();
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const res = await fetch(route.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...route.headers },
        signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
        body,
      });
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * MS_PER_S : RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as SystemOneResponse;
      if (!res.ok || json.error) throw new Error(`Jev: ${route.errorText(json, res.status)}`);
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) if (isAnswerTo(q, json.answers?.[id])) answers[id] = json.answers![id];
      const u = json.usage;
      return {
        result: { answers: answers as DecisionResult<Q>['answers'], costUsd: route.cost(u) },
        tokens: typeof u?.input_tokens === 'number' && typeof u.output_tokens === 'number' ? { input: u.input_tokens, output: u.output_tokens } : null,
      };
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  /** Hands the slot straight to the next waiter, so the count never drops below the cap while work is queued. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }
}
