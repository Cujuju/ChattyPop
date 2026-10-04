// OpenRouter keys: several keys, each paying for the models it lists. Spending caps live on OpenRouter, per key.

/** OpenRouter's API base, for core's requests and main's sign-in. */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/** Pinned, not "latest": Jev thresholds are tuned against one version's probabilities. */
export const JEV_MODEL = 'jev-1.13';
/** Jev's id in OpenRouter's naming, so a key can list it like any other model. */
export const JEV_OPENROUTER_MODEL = `typesafe/${JEV_MODEL}`;

/** Which requests a key pays for. */
export interface OpenRouterKeyRouting {
  label: string;
  /** Model ids this key pays for. */
  models: string[];
  /** Also pays for any model no key lists. */
  anyModel: boolean;
}

/** A stored key as the renderer sees it: never the secret. */
export interface OpenRouterKeyInfo extends OpenRouterKeyRouting {
  id: string;
  /** Last characters of the key, to tell keys apart. */
  hint: string;
}

/** A stored key with its secret; main and core only. */
export interface OpenRouterKeyEntry extends OpenRouterKeyInfo {
  key: string;
}

/** The key's own cap and spend, as OpenRouter reports them (USD). */
export interface OpenRouterKeyBalance {
  /** null = no cap on this key. */
  limitUsd: number | null;
  remainingUsd: number | null;
  /** How often the cap resets (e.g. "monthly"); null = never. */
  limitReset: string | null;
  usageMonthlyUsd: number;
}

/** Characters of the key shown as its hint. */
const HINT_CHARS = 4;
export const keyHint = (key: string): string => `…${key.slice(-HINT_CHARS)}`;

/** The key that pays for `model`: the one listing it, else the any-model key, else null. */
export function keyForModel<K extends OpenRouterKeyRouting>(keys: readonly K[], model: string): K | null {
  return keys.find((k) => k.models.includes(model)) ?? keys.find((k) => k.anyModel) ?? null;
}

/** Throws when routing would be ambiguous: two keys on one model, or two any-model keys. */
export function validateKeyRouting(keys: readonly OpenRouterKeyRouting[]): void {
  const owner = new Map<string, string>();
  let any: string | null = null;
  for (const k of keys) {
    if (!k.label.trim()) throw new Error('Give each key a name.');
    if (k.anyModel) {
      if (any) throw new Error(`Only one key can pay for "any other model" (${any} already does).`);
      any = k.label;
    }
    for (const m of k.models) {
      const other = owner.get(m);
      if (other) throw new Error(`${m} is already on key ${other}.`);
      owner.set(m, k.label);
    }
  }
}
