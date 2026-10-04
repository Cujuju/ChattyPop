import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS, normalizeAiSettings, type AiSettings } from '@shared/settings';
import { JEV_MODEL, JEV_OPENROUTER_MODEL, type OpenRouterKeyEntry } from '@shared/openrouter';
import { ProviderRegistry } from '../src/core/ai/registry';

const jevKey: OpenRouterKeyEntry = { id: 'jev', label: 'Jev', key: 'sk-or-jev', hint: '…', models: [JEV_OPENROUTER_MODEL], anyModel: false };
const on = (connection: AiSettings['jevConnection']): AiSettings => ({ ...DEFAULT_AI_SETTINGS, jevConnection: connection, jev: { ...DEFAULT_AI_SETTINGS.jev, 'summaries.citationCheck': true } });
const question = { state: 'x', questions: { a: { type: 'noul' as const, instructions: 'q' } } };

interface Call {
  url: string;
  auth: string;
  body: { model: string };
}

function stubFetch(status: number, json: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers['authorization']!, body: JSON.parse(init.body) });
    return { ok: status < 400, status, headers: new Headers(), json: async () => json };
  });
  return calls;
}

describe('Jev connection: OpenRouter or TypeSafe directly', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to OpenRouter, and stored settings without the field keep it', () => {
    expect(DEFAULT_AI_SETTINGS.jevConnection).toBe('openrouter');
    expect(normalizeAiSettings({}).jevConnection).toBe('openrouter');
    expect(normalizeAiSettings({ jevConnection: 'typesafe' }).jevConnection).toBe('typesafe');
    expect(normalizeAiSettings({ jevConnection: 'bogus' }).jevConnection).toBe('openrouter');
  });

  it('OpenRouter requests are unchanged: OpenRouter endpoint, OpenRouter key, reported cost', async () => {
    const spent = vi.fn();
    const reg = new ProviderRegistry(spent);
    reg.setOpenRouterKeys([jevKey]);
    reg.setTypeSafeKey('ts-direct');
    const calls = stubFetch(200, { answers: { a: { type: 'noul', noul: 0.9 } }, usage: { cost: 0.001, input_tokens: 100, output_tokens: 5 } });
    const r = await reg.decider(on('openrouter'), 'summaries.citationCheck')!.decide(question);
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/systemone', auth: 'Bearer sk-or-jev', body: expect.objectContaining({ model: JEV_MODEL }) }]);
    expect(r.costUsd).toBe(0.001);
  });

  it('TypeSafe requests go to TypeSafe with the TypeSafe key and versioned model, priced from input tokens', async () => {
    const spent = vi.fn();
    const reg = new ProviderRegistry(spent);
    reg.setOpenRouterKeys([jevKey]);
    reg.setTypeSafeKey('ts-direct');
    const calls = stubFetch(200, { model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1_000_000, output_tokens: 65 } });
    const jev = reg.decider(on('typesafe'), 'summaries.citationCheck')!;
    const r = await jev.decide(question);
    expect(calls).toEqual([{ url: 'https://api.typesafe.ai/v1/systemone', auth: 'Bearer ts-direct', body: expect.objectContaining({ model: `${JEV_MODEL}.0` }) }]);
    expect(r.answers.a?.noul).toBe(0.9);
    expect(r.costUsd).toBeCloseTo(0.042);
    expect(spent).toHaveBeenCalledWith(1, r.costUsd, { input: 1_000_000, output: 65 });
    // Same release name on both routes, so stored judgments and tuned thresholds carry across.
    expect(jev.model).toBe(JEV_MODEL);
  });

  it('TypeSafe chosen without a TypeSafe key: unavailable, and never falls back to OpenRouter', () => {
    const reg = new ProviderRegistry(() => {});
    reg.setOpenRouterKeys([jevKey]);
    expect(reg.decider(on('typesafe'), 'summaries.citationCheck')).toBeNull();
    expect(reg.jevStatus(on('typesafe'))).toMatchObject({ available: false, connection: 'typesafe', keyLabel: null, typeSafeKeyHint: null });
    reg.setTypeSafeKey('ts-direct-abcd');
    expect(reg.jevStatus(on('typesafe'))).toMatchObject({ available: true, keyLabel: 'TypeSafe', typeSafeKeyHint: '…abcd' });
    expect(reg.jevStatus(on('openrouter'))).toMatchObject({ available: true, keyLabel: 'Jev' });
  });

  it('a rejected TypeSafe key says so', async () => {
    const reg = new ProviderRegistry(() => {});
    reg.setTypeSafeKey('ts-bad');
    stubFetch(401, { detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server.' } });
    await expect(reg.decider(on('typesafe'), 'summaries.citationCheck')!.decide(question)).rejects.toThrow(/TypeSafe rejected the key/);
  });

  it('other TypeSafe errors show TypeSafe’s message', async () => {
    const reg = new ProviderRegistry(() => {});
    reg.setTypeSafeKey('ts-ok');
    stubFetch(422, { detail: { error_type: 'invalid_request_error', message: 'questions.a.criteria is required' } });
    await expect(reg.decider(on('typesafe'), 'summaries.citationCheck')!.decide(question)).rejects.toThrow('Jev: TypeSafe: questions.a.criteria is required');
  });
});
