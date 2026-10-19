import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '@plugin-sdk/core';
vi.mock('../src/core/ai/asyncCli', () => ({ resolveCliAsync: async () => ({ command: 'test-cli', args: [] }) }));
const { cliAccounts } = await import('../src/core/ai/cliProvider');
const CHOICE = { model: null, effort: null };
const CLI = { bin: 'test-cli', npm: 'test-cli', name: 'Test CLI' };

function fixture() {
  let key: string | null = null;
  let who: string | null = null;
  const models = vi.fn(async () => []);
  const dispose = vi.fn();
  const provider = vi.fn((account: ProviderAccount) => ({ id: account.id, maxInputChars: 1, complete: async () => ({ text: '' }), listModels: models, dispose }));
  const signOut = vi.fn(async () => { expect(dispose).toHaveBeenCalled(); });
  const impl = cliAccounts({ cli: CLI, provider, checkApiKey: async () => undefined, signedIn: async () => ({ signedIn: who !== null, who }), linkAccount: async () => undefined, signOut });
  const account = (auth: ProviderAccount['auth']): ProviderAccount => ({ id: auth === 'cli' ? 'probe' : `probe@${auth.toLowerCase()}`, auth, apiKey: () => key, dir: auth === 'signIn' ? 'test-account-dir' : null });
  return { impl, models, provider, dispose, signOut, account, key: (next: string | null) => { key = next; }, who: (next: string | null) => { who = next; } };
}

describe('CLI account adapter', () => {
  it('reports each payment route and lists only usable accounts', async () => {
    const h = fixture();
    expect(await h.impl.status(CHOICE, false, h.account('cli'))).toMatchObject({ available: true, detail: 'Uses your Test CLI sign-in' });
    expect(await h.impl.status(CHOICE, false, h.account('apiKey'))).toMatchObject({ available: false, detail: 'Add an API key to use this account' });
    expect(await h.impl.status(CHOICE, false, h.account('signIn'))).toMatchObject({ available: false, detail: 'Not signed in', signedIn: false });
    expect(h.models).toHaveBeenCalledOnce();
    h.key('test-key'); h.who('test@example.test');
    expect(await h.impl.status(CHOICE, false, h.account('apiKey'))).toMatchObject({ available: true, detail: 'Uses your API key' });
    expect(await h.impl.status(CHOICE, false, h.account('signIn'))).toMatchObject({ available: true, detail: 'Signed in as test@example.test', signedIn: true });
  });
  it('keeps one instance per account and refreshes only the changed identity', async () => {
    const h = fixture(); h.key('test-key'); h.who('test@example.test');
    const accounts = ['cli', 'apiKey', 'signIn'].map((auth) => h.account(auth as ProviderAccount['auth']));
    for (const a of accounts) {
      expect(h.impl.create(CHOICE, a)).toBe(h.impl.create(CHOICE, a));
      await h.impl.status(CHOICE, false, a); await h.impl.status(CHOICE, false, a);
    }
    expect(h.provider).toHaveBeenCalledTimes(accounts.length); expect(h.models).toHaveBeenCalledTimes(accounts.length);
    h.key('test-replacement'); await h.impl.status(CHOICE, false, accounts[1]!);
    h.who('other@example.test'); await h.impl.status(CHOICE, false, accounts[2]!);
    expect(h.models).toHaveBeenCalledTimes(accounts.length + 2);
    await h.impl.status(CHOICE, true, accounts[0]!); expect(h.models).toHaveBeenCalledTimes(accounts.length + 3);
  });
  it('disposes removal and unload while preserving stored sign-ins on unload', async () => {
    const h = fixture(); const signIn = h.account('signIn'); const api = h.account('apiKey');
    h.impl.create(CHOICE, signIn); h.impl.create(CHOICE, api);
    await h.impl.removeAccount!(signIn); expect(h.signOut).toHaveBeenCalledWith(signIn); expect(h.dispose).toHaveBeenCalledOnce();
    h.impl.dispose!(); expect(h.dispose).toHaveBeenCalledTimes(2); expect(h.signOut).toHaveBeenCalledOnce();
  });
});
