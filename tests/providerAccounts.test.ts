import { describe, expect, it } from 'vitest';
import { accountKey, accountProvider, newAccountId, ACCOUNT_ID, REMOVED_ACCOUNT } from '@shared/providerAccounts';
import { normalizeAiSettings, normalizeProviderId } from '@shared/aiSettings';
import { accountUnavailable, declaredProvider, providerDeclarations, providerPlugin, providersOf, providerUnavailable } from '@shared/aiProviders';
import { checkBundled } from '@shared/bundledCheck';
import { definePlugin } from '@plugin-sdk/shared';
import { MAIN_INVOKE, RENDERER_CORE_METHODS } from '@shared/contract';
import { remoteAppEvent, remoteMayCallCore, remoteMayCallMain } from '@shared/remote';
import { phoneMayCallCore, phoneMayCallMain, phoneAppEvent } from '@shared/phone';

const plugin = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, providers: [
  { id: 'probe', label: 'Probe · CLI', displayName: 'Probe', enabledByDefault: false, accounts: { signIn: true }, apiKey: { placeholder: 'test-key' }, planUsage: true, images: true },
  { id: 'probe.other', label: 'Other', displayName: 'Other', enabledByDefault: true },
] });
const declared = providerDeclarations([plugin]);

describe('account ids and normalized settings', () => {
  it('parses both ids and generates unused, safe account keys', () => {
    expect(accountProvider('probe.other@abc123')).toBe('probe.other');
    expect(accountKey('probe.other@abc123')).toBe('abc123');
    expect(accountKey('probe')).toBeNull();
    expect(providerPlugin('probe.other@abc123')).toBe('probe');
    const id = newAccountId('probe', ['probe@abc']);
    expect(ACCOUNT_ID.test(id)).toBe(true);
    expect(normalizeProviderId(id)).toBe(id);
    expect(() => newAccountId(id, [])).toThrow();
  });
  it.each(['probe@', 'probe@UPPER', 'probe@../a', 'probe@a@b', 'probe@a-b', 'probe@a.b', 'probe@con', 'probe@prn', 'probe@aux', 'probe@nul', 'probe@com1', 'probe@lpt9'])('refuses malformed %s', (id) => {
    expect(normalizeProviderId(id)).toBeNull();
    expect(() => accountProvider(id)).toThrow();
    expect(() => accountKey(id)).toThrow();
  });
  it('keeps unknown-build accounts, deduplicates ids, defaults them on and keeps names capped', () => {
    const ai = normalizeAiSettings({ accounts: [
      { id: 'probe@a', auth: 'signIn' }, { id: 'probe@a', auth: 'apiKey' }, { id: 'missing@b', auth: 'apiKey' },
      { id: 'probe', auth: 'signIn' }, { id: 'probe@c', auth: 'cli' }, { id: 'probe@../x', auth: 'signIn' }, null,
    ], providers: { 'probe@a': { displayName: '  Work  ' }, 'missing@b': { enabled: false }, 'probe@orphan': { model: 'kept' } } }, declared);
    expect(ai.accounts).toEqual([{ id: 'probe@a', auth: 'signIn' }, { id: 'missing@b', auth: 'apiKey' }]);
    expect(ai.providers['probe@a']).toMatchObject({ enabled: true, displayName: 'Work' });
    expect(ai.providers['missing@b']?.enabled).toBe(false);
    expect(ai.providers['probe@orphan']?.model).toBe('kept');
  });
});

describe('provider list and descriptors', () => {
  it('places accounts immediately after their declaration and retains capabilities', () => {
    const ai = normalizeAiSettings({ accounts: [{ id: 'probe@work', auth: 'signIn' }, { id: 'probe@api', auth: 'apiKey' }], providers: { 'probe@work': { displayName: 'Work' }, 'probe@api': { displayName: 'API' } } }, declared);
    const list = providersOf(ai, declared);
    expect(list.map((p) => p.id)).toEqual(['probe', 'probe@work', 'probe@api', 'probe.other']);
    expect(list[1]).toMatchObject({ label: 'Probe · Work', displayName: 'Work', account: { auth: 'signIn' }, planUsage: true, images: true });
    expect(declaredProvider('probe@api', declared)).toBe(declared[0]);
    expect(providerUnavailable('probe@gone', () => ({ status: 'active', error: null }), declared, ai)).toBe(REMOVED_ACCOUNT);
  });
  it('rejects account ids in declarations and malformed or empty account capabilities', () => {
    expect(() => checkBundled([plugin])).not.toThrow();
    for (const provider of [{ ...plugin.providers[0], id: 'probe@abc' }, { ...plugin.providers[0], accounts: {}, apiKey: undefined }, { ...plugin.providers[0], accounts: { signIn: 'yes' } }])
      expect(() => checkBundled([{ ...plugin, providers: [provider] }] as never)).toThrow();
  });
  it('uses declaration display names without a suffix and refuses shared folder identities', () => {
    const ai = normalizeAiSettings({ accounts: [{ id: 'probe@a', auth: 'signIn' }] }, declared);
    expect(providersOf(ai, declared)[1]?.label).toBe('Probe · Probe');
    const collision = { ...ai, accounts: [{ id: 'probe@a', auth: 'signIn' as const }, { id: 'probe.other@a', auth: 'signIn' as const }] };
    expect(accountUnavailable('probe@a', collision, declared)).toBe('This account shares a storage key with another account.');
    expect(normalizeAiSettings(collision).accounts).toEqual([{ id: 'probe@a', auth: 'signIn' }]);
  });
  it('link methods and events remain on the server screen; account key channels cross', () => {
    for (const method of ['linkProviderAccount', 'submitAccountLinkCode', 'cancelAccountLink']) {
      expect(RENDERER_CORE_METHODS as readonly string[]).toContain(method);
      expect(remoteMayCallCore(method)).toBe(false);
      expect(phoneMayCallCore(method)).toBe(false);
    }
    for (const channel of Object.values(MAIN_INVOKE.providerKeys)) {
      expect(remoteMayCallMain(channel)).toBe(true); expect(phoneMayCallMain(channel)).toBe(true);
    }
    const event = { type: 'account-link' as const, id: 'probe@a', state: 'waiting' as const, url: null, error: null };
    expect(remoteAppEvent(event)).toBeNull(); expect(phoneAppEvent(event)).toBeNull();
  });
});
