// The host's OpenRouter API: key reads, the app's headers and error wording. Jev and the keys card use them, and so
// does the OpenRouter provider, paid through the host's keys.
import { OPENROUTER_API, type OpenRouterKeyBalance } from '@shared/openrouter';

const BALANCE_TIMEOUT_MS = 10_000;
/** `error.metadata.limit_source` when the key's own spending cap is used up. */
const KEY_LIMIT_SOURCE = 'openrouter_key_limit';
/** Identifies ChattyPop in OpenRouter's activity log. */
export const OPENROUTER_APP_HEADERS = { 'HTTP-Referer': 'https://github.com/Cujuju/ChattyPop', 'X-Title': 'ChattyPop' };

/** An OpenRouter error body. */
export interface OpenRouterError {
  message?: string;
  metadata?: { limit_source?: string };
}

/** The user-facing message for a failed OpenRouter request, naming the key when its own cap stopped it. */
export function openRouterErrorText(error: OpenRouterError | undefined, status: number, keyLabel: string): string {
  if (error?.metadata?.limit_source === KEY_LIMIT_SOURCE) return `Key "${keyLabel}" reached its OpenRouter spending limit. Raise it on openrouter.ai or wait for it to reset.`;
  return error?.message ?? `HTTP ${status}`;
}

/** The key's own cap and spend. */
export async function openRouterKeyBalance(key: string): Promise<OpenRouterKeyBalance> {
  const res = await fetch(`${OPENROUTER_API}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter key info: HTTP ${res.status}`);
  const { data } = (await res.json()) as { data: { limit: number | null; limit_remaining: number | null; limit_reset: string | null; usage_monthly: number } };
  return { limitUsd: data.limit, remainingUsd: data.limit_remaining, limitReset: data.limit_reset, usageMonthlyUsd: data.usage_monthly };
}
