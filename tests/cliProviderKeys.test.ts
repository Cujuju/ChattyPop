import { describe, expect, it, vi } from 'vitest';
vi.mock('@core/ai/resolveCli', () => ({ resolveCli: () => ({ command: 'test-cli', args: [] }) }));
const { signedInCli } = await import('../src/core/ai/cliProvider');
import type { LlmProvider } from '../src/core/ai/types';

const CLI = { bin: 'test-cli', npm: 'test-cli', name: 'Test CLI' };
const CHOICE = { model: null, effort: null };

describe('CLI payment mode and model cache', () => {
  it('re-lists on key set, replacement and removal, without refresh', async () => {
    let key: string | null = null;
    const listModels = vi.fn(async () => [{ id: key ?? 'sign-in', label: 'Model' }]);
    const provider: LlmProvider = { id: 'probe', maxInputChars: 1, listModels, complete: async () => ({ text: '' }) };
    const check = vi.fn(async (_value: string) => undefined);
    const impl = signedInCli(CLI, provider, { apiKey: () => key, check });
    expect((await impl.status(CHOICE, false)).detail).toBe('Uses your Test CLI sign-in');
    await impl.status(CHOICE, false);
    expect(listModels).toHaveBeenCalledTimes(1);
    key = 'test-key';
    expect(await impl.status(CHOICE, false)).toMatchObject({ detail: 'Uses your API key', models: [{ id: key }] });
    await impl.status(CHOICE, false);
    expect(listModels).toHaveBeenCalledTimes(2);
    key = 'test-replacement';
    await impl.status(CHOICE, false);
    expect(listModels).toHaveBeenCalledTimes(3);
    key = null;
    expect((await impl.status(CHOICE, false)).detail).toBe('Uses your Test CLI sign-in');
    expect(listModels).toHaveBeenCalledTimes(4);
    await impl.checkApiKey!('test-key');
    expect(check).toHaveBeenCalledWith('test-key');
  });
  it('without auth retains sign-in behavior and refresh semantics', async () => {
    const listModels = vi.fn(async () => []);
    const impl = signedInCli(CLI, { id: 'probe', maxInputChars: 1, listModels, complete: async () => ({ text: '' }) });
    await impl.status(CHOICE, false);
    await impl.status(CHOICE, false);
    await impl.status(CHOICE, true);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(impl.checkApiKey).toBeUndefined();
  });
  it('concurrent status reads share a listing for the unchanged key', async () => {
    const listModels = vi.fn(async () => []);
    const impl = signedInCli(CLI, { id: 'probe', maxInputChars: 1, listModels, complete: async () => ({ text: '' }) },
      { apiKey: () => 'test-key', check: async () => undefined });
    await Promise.all([impl.status(CHOICE, false), impl.status(CHOICE, false)]);
    expect(listModels).toHaveBeenCalledOnce();
  });
});
