import { describe, expect, it } from 'vitest';
import { modelRates, priceUsage } from '../src/core/ai/apiRates';

// Shaped like OpenRouter's catalogue entry for openai/gpt-6.1-sol (2026-09-29).
const SOL = modelRates({
  prompt: '0.000002',
  completion: '0.00001',
  input_cache_read: '0.0000001',
  input_cache_write: '0.0000025',
  overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004', completion: '0.000015', input_cache_read: '0.0000002', input_cache_write: '0.000005' }],
})!;
const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, largestPromptTokens: 0 };

describe('API-rate pricing', () => {
  it('prices fresh, cached, cache-written and output tokens at their own rates', () => {
    const u = { ...usage, inputTokens: 76_651, cachedInputTokens: 38_016, cacheWriteInputTokens: 1_000, outputTokens: 4_100, largestPromptTokens: 40_000 };
    expect(priceUsage(SOL, u)).toBeCloseTo(37_635 * 2e-6 + 38_016 * 1e-7 + 1_000 * 2.5e-6 + 4_100 * 1e-5, 10);
  });

  it('switches to the long-context tier when one request reaches its minimum', () => {
    const u = { ...usage, inputTokens: 272_000, outputTokens: 10, largestPromptTokens: 272_000 };
    expect(priceUsage(SOL, u)).toBeCloseTo(272_000 * 4e-6 + 10 * 1.5e-5, 10);
    expect(priceUsage(SOL, { ...u, largestPromptTokens: 271_999 })).toBeCloseTo(272_000 * 2e-6 + 10 * 1e-5, 10);
  });

  it('prices cache tokens as prompt when the catalogue lists no cache rate', () => {
    const rates = modelRates({ prompt: '0.000001', completion: '0.000002' })!;
    expect(priceUsage(rates, { ...usage, inputTokens: 100, cachedInputTokens: 60 })).toBeCloseTo(100 * 1e-6, 12);
  });

  it('rejects entries without usable base prices', () => {
    expect(modelRates({ prompt: '0.000001' })).toBeNull();
    expect(modelRates({ prompt: '-1', completion: '0.000001' })).toBeNull();
  });
});
