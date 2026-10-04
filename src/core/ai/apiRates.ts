// API list rates, from OpenRouter's public catalogue, to price calls a subscription pays for (Codex).
import { OPENROUTER_API } from '@shared/openrouter';
import { MS_PER_DAY } from '@shared/units';

/** OpenRouter's public model catalogue; no key, so it prices calls whether or not the OpenRouter plugin is on. */
const CATALOGUE_URL = `${OPENROUTER_API}/models`;
/** A catalogue read slower than this counts as unreachable; the call is then left unpriced. */
const CATALOGUE_TIMEOUT_MS = 5000;

/** USD per token, as decimal strings; overrides replace them from a minimum prompt size up. */
export interface CataloguePricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: (Omit<CataloguePricing, 'overrides'> & { min_prompt_tokens: number })[];
}

/** Every model the catalogue lists, with its prices. */
async function openRouterCatalogue(): Promise<{ id: string; pricing?: CataloguePricing }[]> {
  const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  return ((await res.json()) as { data: { id: string; pricing?: CataloguePricing }[] }).data;
}

/** USD per token. A null cache rate means the catalogue lists none; those tokens are priced as prompt. */
interface Rates {
  prompt: number;
  completion: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** Base rates, plus overrides that apply once one request's prompt reaches their minimum (long-context pricing). */
export interface ModelRates extends Rates {
  overrides: (Rates & { minPromptTokens: number })[];
}

/** One call's tokens. `inputTokens` includes the cached and cache-written ones. */
export interface PricedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  /** The call's largest single-request prompt; picks the long-context tier. */
  largestPromptTokens: number;
}

/** List prices change a few times a year; a day-old copy is current enough and spares a fetch per call. */
const CATALOGUE_TTL_MS = MS_PER_DAY;

const perToken = (v: string | undefined): number | null => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const ratesOf = (p: CataloguePricing): Rates | null => {
  const prompt = perToken(p.prompt);
  const completion = perToken(p.completion);
  if (prompt === null || completion === null) return null;
  return { prompt, completion, cacheRead: perToken(p.input_cache_read), cacheWrite: perToken(p.input_cache_write) };
};

/** A catalogue entry's rates; null when its base prices are missing or malformed. */
export function modelRates(p: CataloguePricing): ModelRates | null {
  const base = ratesOf(p);
  if (!base) return null;
  const overrides = (p.overrides ?? []).flatMap((o) => {
    const r = ratesOf({ ...p, ...o });
    return r && Number.isFinite(o.min_prompt_tokens) ? [{ ...r, minPromptTokens: o.min_prompt_tokens }] : [];
  });
  return { ...base, overrides: overrides.sort((a, b) => a.minPromptTokens - b.minPromptTokens) };
}

/** What the call would cost at these rates, in USD. */
export function priceUsage(rates: ModelRates, u: PricedUsage): number {
  const r = rates.overrides.findLast((o) => u.largestPromptTokens >= o.minPromptTokens) ?? rates;
  const fresh = Math.max(0, u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens);
  return (
    fresh * r.prompt +
    u.cachedInputTokens * (r.cacheRead ?? r.prompt) +
    u.cacheWriteInputTokens * (r.cacheWrite ?? r.prompt) +
    u.outputTokens * r.completion
  );
}

let catalogue: { at: number; rates: Promise<Map<string, ModelRates>> } | undefined;

/** Rates by OpenRouter model id (`openai/gpt-…`); a failed fetch isn't kept, so the next call retries. */
function catalogueRates(): Promise<Map<string, ModelRates>> {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.rates;
  const rates = openRouterCatalogue().then(
    (models) => new Map(models.flatMap((m) => {
      const r = m.pricing && modelRates(m.pricing);
      return r ? [[m.id, r] as const] : [];
    })),
  );
  const entry = { at: Date.now(), rates };
  catalogue = entry;
  rates.catch(() => {
    if (catalogue === entry) catalogue = undefined;
  });
  return rates;
}

/** Prices one call at API list rates by OpenRouter model id; undefined when unknown. */
export type PriceAtApiRates = (openRouterId: string, u: PricedUsage) => Promise<number | undefined>;

/** The call's cost at the model's API list rates; undefined when the catalogue is unreachable or doesn't list the model. */
export const apiCost: PriceAtApiRates = async (openRouterId, u) => {
  const rates = await catalogueRates().catch(() => undefined);
  const r = rates?.get(openRouterId);
  return r ? priceUsage(r, u) : undefined;
};
