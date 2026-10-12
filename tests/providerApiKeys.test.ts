import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type ProviderImpl } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import { providerDeclarations } from '@shared/aiProviders';
import { HOST_PROVIDER_ROWS } from '@shared/anchors';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { ProviderRegistry } from '../src/core/ai/registry';
import { startProviders } from './providerHost';

const KEY = 'test-key-abcd';
const plugin = definePlugin({
  manifest: { id: 'keyprobe', name: 'Key probe', version: '1', description: '' },
  providers: [
    { id: 'keyprobe', label: 'Key probe', displayName: 'Key probe', enabledByDefault: true, apiKey: { placeholder: 'test-key' } },
    { id: 'keyprobe.plain', label: 'Plain', displayName: 'Plain', enabledByDefault: false },
  ],
});
const other = definePlugin({
  manifest: { id: 'other', name: 'Other', version: '1', description: '' },
  providers: [{ id: 'other', label: 'Other', displayName: 'Other', enabledByDefault: true, apiKey: { placeholder: 'test-key' } }],
});
const implementation = (checkApiKey = vi.fn(async (_key: string) => undefined)): ProviderImpl => ({
  create: () => ({ id: 'keyprobe', maxInputChars: 1, complete: async () => ({ text: 'answer' }), listModels: async () => [] }),
  status: async () => ({ available: true, detail: 'ready', models: [] }),
  checkApiKey,
});

describe('provider API key contract', () => {
  it('scopes current keys to a declaration and clears access when unloaded', async () => {
    let ctx!: CoreContext<typeof plugin>;
    const initial: (string | null)[] = [];
    const entry = defineCorePlugin(plugin, (context) => {
      ctx = context;
      initial.push(ctx.ai.apiKey('keyprobe'));
      ctx.ai.registerProvider('keyprobe', implementation());
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    });
    const foreign = defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', implementation()));
    const { host, registry } = startProviders([entry, foreign], [plugin, other], undefined, { apiKeys: { keyprobe: KEY, other: 'test-other-key' } });
    expect(initial).toEqual([KEY]);
    expect(ctx.ai.apiKey('keyprobe')).toBe(KEY);
    expect(() => ctx.ai.apiKey('keyprobe.plain')).toThrow(/declares no apiKey/);
    expect(() => ctx.ai.apiKey('other' as never)).toThrow(/declares none/);
    registry.setProviderApiKeys({});
    expect(ctx.ai.apiKey('keyprobe')).toBeNull();
    registry.setProviderApiKeys({ keyprobe: KEY });
    await host.setEnabled('keyprobe', false);
    expect(ctx.ai.apiKey('keyprobe')).toBeNull();
  });

  it('the SDK test host seeds credentials before activation', async () => {
    let read: string | null = null;
    const entry = defineCorePlugin(plugin, (ctx) => {
      read = ctx.ai.apiKey('keyprobe');
      ctx.ai.registerProvider('keyprobe', implementation());
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    });
    const host = testPlugin(entry, { ai: { apiKeys: { keyprobe: KEY } } });
    try { expect(read).toBe(KEY); } finally { await host.dispose(); }
  });

  it('reports hints on successful and failed rows, never the credential', async () => {
    const impl = implementation();
    const { registry, ai } = startProviders([defineCorePlugin(plugin, (ctx) => {
      ctx.ai.registerProvider('keyprobe', impl);
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    })]);
    expect((await registry.status(ai()))[0]?.apiKeyHint).toBeNull();
    registry.setProviderApiKeys({ keyprobe: KEY, 'keyprobe.plain': KEY });
    const statuses = await registry.status(ai());
    expect(statuses.map((row) => row.apiKeyHint)).toEqual(['…abcd', null]);
    expect(JSON.stringify(statuses)).not.toContain(KEY);
    impl.status = async () => { throw new Error(`failure ${KEY}`); };
    const failed = await registry.status(ai());
    expect(failed[0]).toMatchObject({ available: false, apiKeyHint: '…abcd', detail: 'failure [API key]' });
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it('validates with the running provider and rejects invalid registration contracts', async () => {
    const registry = new ProviderRegistry(() => undefined, providerDeclarations([plugin]));
    await expect(registry.checkApiKey('keyprobe', KEY)).rejects.toThrow(/plugin, which is off/);
    await expect(registry.checkApiKey('absent', KEY)).rejects.toThrow(/not declared/);
    await expect(registry.checkApiKey('keyprobe.plain', KEY)).rejects.toThrow(/not declared/);
    const check = vi.fn(async (_key: string) => undefined);
    const impl = implementation(check);
    const off = registry.register('keyprobe', impl);
    await registry.checkApiKey('keyprobe', KEY);
    expect(check).toHaveBeenCalledWith(KEY);
    delete impl.checkApiKey;
    await expect(registry.checkApiKey('keyprobe', KEY)).rejects.toThrow(/supplies no check/);
    off();
    expect(() => registry.register('keyprobe', impl)).toThrow(/supplies no check/);
  });

  it('key-check errors cannot expose pasted keys in plugin state', async () => {
    const { host, registry } = startProviders([defineCorePlugin(plugin, (ctx) => {
      ctx.ai.registerProvider('keyprobe', implementation(vi.fn(async (key: string) => { throw new Error(`Rejected ${key}`); })));
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    })]);
    await expect(registry.checkApiKey('keyprobe', KEY)).rejects.toThrow('Rejected [API key]');
    expect(JSON.stringify(host.list())).not.toContain(KEY);
  });
  it('completion errors started under an earlier key cannot expose that key', async () => {
    let reject!: (error: Error) => void;
    const impl = implementation();
    impl.create = () => ({ id: 'keyprobe', maxInputChars: 1, listModels: async () => [], complete: () => new Promise((_, fail) => { reject = fail; }) });
    const registry = new ProviderRegistry(() => undefined, providerDeclarations([plugin]));
    registry.register('keyprobe', impl);
    registry.setProviderApiKeys({ keyprobe: KEY });
    const pending = registry.get('keyprobe', { providers: {} } as never).complete({ system: '', prompt: '' });
    registry.setProviderApiKeys({});
    reject(new Error(`Failed ${KEY}`));
    await expect(pending).rejects.toThrow('Failed [API key]');
  });
  it('a declared id cannot read a prototype property as a credential', () => {
    const declaration = { ...plugin.providers[0], id: 'constructor' };
    const registry = new ProviderRegistry(() => undefined, [{ ...declaration, plugin: { id: 'constructor', name: 'Constructor' } }]);
    expect(registry.apiKey('constructor')).toBeNull();
  });
});

describe('API key descriptors and placement', () => {
  it.each([null, {}, { placeholder: '' }, { placeholder: ' ' }, { placeholder: 1 }])('refuses malformed apiKey: %j', (apiKey) => {
    const invalid = { ...plugin, providers: [{ ...plugin.providers[0], apiKey }] } as unknown as PluginDescriptor;
    expect(() => checkBundled([invalid])).toThrow(/non-empty placeholder/);
  });
  it('accepts a key declaration and places its row after enabled', () => {
    expect(() => checkBundled([plugin])).not.toThrow();
    expect(HOST_PROVIDER_ROWS).toEqual(['enabled', 'api-key', 'model', 'effort', 'plan-usage', 'rows']);
  });
});
