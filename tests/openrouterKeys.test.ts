// OpenRouter keys (the host's @shared/openrouter): routing a model to the key that lists it.
import { describe, expect, it } from 'vitest';
import { JEV_OPENROUTER_MODEL, decodeKeyRouting, keyForModel, validateKeyRouting, type OpenRouterKeyEntry } from '@shared/openrouter';

const key = (id: string, models: string[], anyModel = false): OpenRouterKeyEntry => ({ id, label: id, key: `sk-${id}`, hint: '…', models, anyModel });
const jevKey = key('jev', [JEV_OPENROUTER_MODEL]);
const sonnet = key('sonnet', ['anthropic/claude-sonnet-5']);
const any = key('any', [], true);

describe('OpenRouter key routing', () => {
  it('prefers the key listing the model, then the any-model key, else none', () => {
    expect(keyForModel([any, sonnet], 'anthropic/claude-sonnet-5')?.id).toBe('sonnet');
    expect(keyForModel([jevKey, sonnet, any], 'openai/gpt-5')?.id).toBe('any');
    expect(keyForModel([jevKey, sonnet], 'openai/gpt-5')).toBeNull();
  });

  it('rejects ambiguous routing', () => {
    expect(() => validateKeyRouting([any, key('any2', [], true)])).toThrow(/Only one key/);
    expect(() => validateKeyRouting([jevKey, key('dup', [JEV_OPENROUTER_MODEL])])).toThrow(/already on key jev/);
    expect(() => validateKeyRouting([key(' ', [])])).toThrow(/name/);
  });

  it('decodes routing from a window or the phone, refusing any other shape', () => {
    const routing = { label: 'Jev', models: [JEV_OPENROUTER_MODEL], anyModel: false };
    expect(decodeKeyRouting({ ...routing, extra: 1 })).toEqual(routing);
    for (const bad of [null, 'Jev', { ...routing, models: 'a/b' }, { ...routing, models: [1] }, { ...routing, anyModel: 'false' }, { ...routing, label: 3 }]) {
      expect(() => decodeKeyRouting(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});
