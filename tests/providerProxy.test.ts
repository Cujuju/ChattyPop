import { describe, expect, it } from 'vitest';
import { normalizeAiSettings, normalizeProxyUrl, type AiSettings } from '@shared/aiSettings';
import { PROXY_UNSET, providerDeclarations, proxyApplies } from '@shared/aiProviders';
import { definePlugin } from '@plugin-sdk/shared';
import type { ProviderAccount, ProviderImpl } from '@plugin-sdk/core';
import { ProviderRegistry } from '../src/core/ai/registry';
import { tempDir } from './helpers';

const PROXY = 'http://127.0.0.1:8317';
const plugin = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, providers: [
  { id: 'probe', label: 'Probe', displayName: 'Probe', accounts: { signIn: true }, apiKey: { placeholder: 'test-key' }, proxy: true },
  { id: 'probe.direct', label: 'Direct', displayName: 'Direct' },
] });
const declared = providerDeclarations([plugin]);
const ACCOUNTS = [{ id: 'probe@work', auth: 'signIn' }, { id: 'probe@api', auth: 'apiKey' }];
const allOn = { probe: { enabled: true, proxy: true }, 'probe@work': { proxy: true }, 'probe@api': { proxy: true }, 'probe.direct': { enabled: true, proxy: true } };

function start(stored: unknown) {
  let settings: AiSettings = normalizeAiSettings(stored, declared);
  const seen = new Map<string, ProviderAccount>();
  const impl: ProviderImpl = {
    create: (_choice, account) => {
      seen.set(account.id, account);
      return { id: account.id, maxInputChars: 1, complete: async () => { throw new Error('refused secret-key'); }, listModels: async () => [] };
    },
    status: async () => ({ available: true, detail: 'ok', models: [] }),
    checkApiKey: async () => undefined,
    linkAccount: async () => undefined,
  };
  const registry = new ProviderRegistry(() => undefined, declared);
  registry.bindAccounts(() => settings, () => undefined);
  registry.register('probe', impl, tempDir());
  registry.register('probe.direct', impl);
  return { registry, seen, settings: () => settings, save: (next: unknown) => { settings = normalizeAiSettings(next, declared); } };
}

describe('provider proxy', () => {
  it('stores only an http(s) address, without its trailing slash, and every switch off by default', () => {
    expect(normalizeProxyUrl(` ${PROXY}/ `)).toBe(PROXY);
    expect(normalizeProxyUrl('https://proxy.lan/api/')).toBe('https://proxy.lan/api');
    for (const bad of ['', 'proxy.lan', 'ftp://proxy.lan', 7]) expect(normalizeProxyUrl(bad)).toBeNull();
    const ai = normalizeAiSettings({ accounts: ACCOUNTS }, declared);
    expect(ai.proxy).toEqual({ url: null });
    expect(Object.values(ai.providers).map((p) => p.proxy)).toEqual([false, false, false, false]);
  });

  it('applies to providers declaring it, never to an API-key account', () => {
    const ai = normalizeAiSettings({ accounts: ACCOUNTS }, declared);
    expect(['probe', 'probe@work', 'probe@api', 'probe.direct'].map((id) => proxyApplies(id, ai, declared))).toEqual([true, true, false, false]);
  });

  it('hands a switched provider the address and the current key, read per request', () => {
    const h = start({ accounts: ACCOUNTS, providers: allOn, proxy: { url: PROXY } });
    h.registry.setProxyKey('client-key');
    for (const id of ['probe', 'probe@work', 'probe@api', 'probe.direct']) h.registry.get(id, h.settings());
    const proxyOf = (id: string) => h.seen.get(id)!.proxy?.();
    expect(proxyOf('probe')).toEqual({ url: PROXY, key: 'client-key' });
    expect(proxyOf('probe@work')).toEqual({ url: PROXY, key: 'client-key' });
    expect(proxyOf('probe@api')).toBeNull();
    expect(proxyOf('probe.direct')).toBeNull();
    h.registry.setProxyKey(null);
    expect(proxyOf('probe')).toEqual({ url: PROXY, key: null });
    expect(h.registry.proxyKeyHint()).toBeNull();
    h.save({ accounts: ACCOUNTS, providers: { ...allOn, probe: { enabled: true, proxy: false } }, proxy: { url: PROXY } });
    expect(proxyOf('probe')).toBeNull();
  });

  it('makes a switched provider unavailable while no address is set, rather than going direct', async () => {
    const h = start({ accounts: ACCOUNTS, providers: allOn });
    expect(h.registry.unavailable('probe')).toBe(PROXY_UNSET);
    expect(h.registry.runs('probe')).toBe(false);
    expect(() => h.registry.get('probe', h.settings())).toThrow(PROXY_UNSET);
    const status = await h.registry.status(h.settings());
    expect(status.find((s) => s.id === 'probe')).toMatchObject({ available: false, detail: PROXY_UNSET });
    // An API-key account ignores a stored switch: it never uses the proxy.
    expect(h.registry.unavailable('probe@api')).toBeNull();
  });

  it('redacts the proxy key from provider errors', async () => {
    const h = start({ accounts: ACCOUNTS, providers: allOn, proxy: { url: PROXY } });
    h.registry.setProxyKey('secret-key');
    expect(h.registry.proxyKeyHint()).not.toContain('secret');
    await expect(h.registry.get('probe', h.settings()).complete({ system: '', prompt: '' })).rejects.toThrow('refused [API key]');
  });
});
