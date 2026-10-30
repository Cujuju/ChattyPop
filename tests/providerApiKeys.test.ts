import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type ProviderImpl } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import { providerDeclarations } from '@shared/aiProviders';
import { HOST_PROVIDER_ROWS } from '@shared/anchors';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { ProviderRegistry } from '../src/core/ai/registry';
import { normalizeAiSettings } from '@shared/aiSettings';
import { tempDir } from './helpers';
import { startProviders } from './providerHost';

const ACCOUNTS = [{ id: 'keyprobe@api', auth: 'apiKey' as const }];
const KEY = 'test-key-abcd';
const plugin = definePlugin({
  manifest: { id: 'keyprobe', name: 'Key probe', version: '1', description: '' },
  providers: [
    { id: 'keyprobe', label: 'Key probe', displayName: 'Key probe', enabledByDefault: true, accounts: {}, apiKey: { placeholder: 'test-key' } },
    { id: 'keyprobe.plain', label: 'Plain', displayName: 'Plain', enabledByDefault: false },
  ],
});
const other = definePlugin({
  manifest: { id: 'other', name: 'Other', version: '1', description: '' },
  providers: [{ id: 'other', label: 'Other', displayName: 'Other', enabledByDefault: true, accounts: {}, apiKey: { placeholder: 'test-key' } }],
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
      initial.push(ctx.ai.apiKey('keyprobe@api'));
      ctx.ai.registerProvider('keyprobe', implementation());
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    });
    const foreign = defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', implementation()));
    const { host, registry } = startProviders([entry, foreign], [plugin, other], undefined, { accounts: ACCOUNTS, apiKeys: { 'keyprobe@api': KEY, other: 'test-other-key' } });
    expect(initial).toEqual([KEY]);
    expect(ctx.ai.apiKey('keyprobe@api')).toBe(KEY);
    expect(() => ctx.ai.apiKey('keyprobe.plain')).toThrow(/declares no apiKey/);
    expect(() => ctx.ai.apiKey('other' as never)).toThrow(/declares none/);
    registry.setProviderApiKeys({});
    expect(ctx.ai.apiKey('keyprobe@api')).toBeNull();
    registry.setProviderApiKeys({ 'keyprobe@api': KEY });
    await host.setEnabled('keyprobe', false);
    expect(ctx.ai.apiKey('keyprobe@api')).toBeNull();
  });

  it('the SDK test host seeds credentials before activation', async () => {
    let read: string | null = null;
    const entry = defineCorePlugin(plugin, (ctx) => {
      read = ctx.ai.apiKey('keyprobe@api');
      ctx.ai.registerProvider('keyprobe', implementation());
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    });
    const host = testPlugin(entry, { ai: { accounts: ACCOUNTS, apiKeys: { 'keyprobe@api': KEY } } });
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
    impl.status = async () => ({ available: true, detail: 'ready', models: [], credential: KEY, signedIn: true });
    expect(JSON.stringify(await registry.status(ai()))).not.toContain(KEY);
    expect((await registry.status(ai()))[0]?.signedIn).toBeUndefined();
    impl.status = async () => { throw new Error(`failure ${KEY}`); };
    const failed = await registry.status(ai());
    expect(failed[0]).toMatchObject({ available: false, apiKeyHint: '…abcd', detail: 'failure [API key]' });
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it('validates with the running provider and rejects invalid registration contracts', async () => {
    const registry = new ProviderRegistry(() => undefined, providerDeclarations([plugin]));
    const settings = normalizeAiSettings({ accounts: ACCOUNTS });
    registry.bindAccounts(() => settings, () => undefined);
    await expect(registry.checkApiKey('keyprobe@api', KEY)).rejects.toThrow(/plugin, which is off/);
    await expect(registry.checkApiKey('absent', KEY)).rejects.toThrow(/existing API-key account/);
    await expect(registry.checkApiKey('keyprobe.plain', KEY)).rejects.toThrow(/existing API-key account/);
    const check = vi.fn(async (_key: string) => undefined);
    const impl = implementation(check);
    const off = registry.register('keyprobe', impl, tempDir());
    await registry.checkApiKey('keyprobe@api', KEY);
    expect(check).toHaveBeenCalledWith(KEY);
    delete impl.checkApiKey;
    await expect(registry.checkApiKey('keyprobe@api', KEY)).rejects.toThrow(/supplies no check/);
    off();
    expect(() => registry.register('keyprobe', impl, tempDir())).toThrow(/supplies no check/);
  });

  it('key-check errors cannot expose pasted keys in plugin state', async () => {
    const { host, registry } = startProviders([defineCorePlugin(plugin, (ctx) => {
      ctx.ai.registerProvider('keyprobe', implementation(vi.fn(async (key: string) => { throw new Error(`Rejected ${key}`); })));
      ctx.ai.registerProvider('keyprobe.plain', implementation());
    })], [plugin], undefined, { accounts: ACCOUNTS });
    await expect(registry.checkApiKey('keyprobe@api', KEY)).rejects.toThrow('Rejected [API key]');
    expect(JSON.stringify(host.list())).not.toContain(KEY);
  });
  it('completion errors started under an earlier key cannot expose that key', async () => {
    let reject!: (error: Error) => void;
    const impl = implementation();
    impl.create = () => ({ id: 'keyprobe', maxInputChars: 1, listModels: async () => [], complete: () => new Promise((_, fail) => { reject = fail; }) });
    const registry = new ProviderRegistry(() => undefined, providerDeclarations([plugin]));
    const settings = normalizeAiSettings({ accounts: ACCOUNTS });
    registry.bindAccounts(() => settings, () => undefined);
    registry.register('keyprobe', impl, tempDir());
    registry.setProviderApiKeys({ 'keyprobe@api': KEY });
    const pending = registry.get('keyprobe@api', settings).complete({ system: '', prompt: '' });
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
    expect(HOST_PROVIDER_ROWS).toEqual(['enabled', 'account', 'api-key', 'proxy', 'model', 'effort', 'plan-usage', 'rows']);
  });
});
