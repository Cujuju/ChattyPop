import { mkdirSync, existsSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeAiSettings } from '@shared/aiSettings';
import { providerDeclarations } from '@shared/aiProviders';
import { REMOVED_ACCOUNT } from '@shared/providerAccounts';
import type { AppEvent } from '@shared/contract';
import { definePlugin } from '@plugin-sdk/shared';
import type { AccountLinkIo, ProviderAccount, ProviderImpl } from '@plugin-sdk/core';
import { ProviderRegistry } from '../src/core/ai/registry';
import { ACCOUNTS_DIR, accountDir, removeAccountDir, prepareAccountRemoval } from '../src/core/ai/accountFolders';
import { tempDir } from './helpers';

const plugin = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, providers: [
  { id: 'probe', label: 'Probe', displayName: 'Probe', enabledByDefault: true, accounts: { signIn: true }, apiKey: { placeholder: 'test-key' }, planUsage: true },
] });
const declared = providerDeclarations([plugin]);
const WINDOW = { id: 'w', label: 'W', usedPercent: null, resetsAt: null, durationMs: null };
const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
function start(link: ProviderImpl['linkAccount'] = async () => undefined) {
  let settings = normalizeAiSettings({ accounts: [{ id: 'probe@work', auth: 'signIn' }, { id: 'probe@api', auth: 'apiKey' }], providers: { 'probe@work': { displayName: 'Work' } } }, declared);
  const dataDir = tempDir();
  const events: AppEvent[] = [];
  const seen: ProviderAccount[] = [];
  const impl: ProviderImpl = {
    create: (_choice, account) => {
      seen.push(account);
      return { id: 'probe', maxInputChars: 1, complete: async () => ({ text: `${account.id}:${account.apiKey()}` }), listModels: async () => [], planUsage: async () => [WINDOW] };
    },
    status: async (_choice, _refresh, account) => ({ available: true, detail: account.id, models: [], ...(account.auth === 'signIn' ? { signedIn: true } : {}) }),
    checkApiKey: vi.fn(async () => undefined), linkAccount: link,
    removeAccount: vi.fn(async () => undefined),
  };
  const registry = new ProviderRegistry(() => undefined, declared);
  registry.bindAccounts(() => settings, (event) => events.push(event));
  const off = registry.register('probe', impl, dataDir);
  const save = async (stored: unknown): Promise<void> => { settings = normalizeAiSettings(stored, declared); await registry.accountsChanged(settings); };
  return { registry, impl, dataDir, events, seen, off, settings: () => settings, save };
}

describe('account routing and storage', () => {
  it('routes per account, names the handed-out provider and ignores keys without API-key accounts', async () => {
    const h = start();
    h.registry.setProviderApiKeys({ probe: 'test-key', 'probe@work': 'test-key', 'probe@api': 'test-key', 'probe@orphan': 'test-key' });
    const provider = h.registry.get('probe@api', h.settings());
    expect(provider.id).toBe('probe@api');
    expect(await provider.complete({ system: '', prompt: '' })).toEqual({ text: 'probe@api:test-key' });
    for (const id of ['probe', 'probe@work', 'probe@orphan']) expect(h.registry.apiKey(id)).toBeNull();
    expect((await h.registry.status(h.settings())).map((s) => [s.id, s.auth])).toEqual([['probe', 'cli'], ['probe@work', 'signIn'], ['probe@api', 'apiKey']]);
    expect(await h.registry.planUsage('probe@work', h.settings())).toEqual([WINDOW]);
    expect(h.registry.providers().map((p) => p.id)).toEqual(['probe', 'probe@work', 'probe@api']);
    expect(h.registry.unavailable('probe@gone')).toBe(REMOVED_ACCOUNT);
    expect(() => h.registry.get('probe@gone', h.settings())).toThrow(REMOVED_ACCOUNT);
    await expect(h.registry.checkApiKey('probe', 'test-key')).rejects.toThrow('existing API-key account');
    await expect(h.registry.checkApiKey('probe@work', 'test-key')).rejects.toThrow('existing API-key account');
    await h.registry.checkApiKey('probe@api', 'test-key');
    expect(h.impl.checkApiKey).toHaveBeenCalledWith('test-key');
  });
  it('requires linkAccount and a data folder for a sign-in declaration', () => {
    const h = start(); h.off();
    expect(() => h.registry.register('probe', { ...h.impl, linkAccount: undefined }, h.dataDir)).toThrow('no linkAccount');
    expect(() => h.registry.register('probe', h.impl)).toThrow('plugin storage');
    expect(() => h.registry.register('probe@a', h.impl, h.dataDir)).toThrow('No AI provider');
  });
  it('keeps unsupported account records without routing them through an older machine-only provider', async () => {
    const h = start(); const create = vi.fn(h.impl.create);
    const older = declared.map((d) => ({ ...d, accounts: undefined }));
    const registry = new ProviderRegistry(() => undefined, older);
    registry.bindAccounts(h.settings, () => undefined); registry.register('probe', { ...h.impl, create }, tempDir());
    expect(() => registry.get('probe@work', h.settings())).toThrow('no longer supports');
    expect(registry.runs('probe@api')).toBe(false); expect(registry.apiKey('probe@api')).toBeNull();
    expect((await registry.status(h.settings())).find((row) => row.id === 'probe@work')).toMatchObject({ available: false, detail: 'This provider no longer supports this account kind.' });
    expect(create).not.toHaveBeenCalled();
  });
  it('revokes removed accounts, signs out before deleting, and leaves owner settings alone', async () => {
    const h = start();
    const p = h.registry.get('probe@work', h.settings());
    const dir = accountDir(h.dataDir, 'probe@work');
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'test.txt'), 'test');
    expect(h.seen[0]?.dir).toBe(join(h.dataDir, ACCOUNTS_DIR, 'work'));
    h.impl.removeAccount = vi.fn(async (account) => { expect(account.id).toBe('probe@work'); expect(existsSync(dir)).toBe(true); });
    await h.save({ accounts: [{ id: 'probe@api', auth: 'apiKey' }], providers: h.settings().providers });
    expect(h.impl.removeAccount).toHaveBeenCalledOnce(); expect(existsSync(dir)).toBe(false);
    await expect(p.complete({ system: '', prompt: '' })).rejects.toThrow(REMOVED_ACCOUNT);
    expect(h.settings().providers['probe@work']).toBeDefined();
  });
  it('sweeps orphan folders on activation, keeps accounts, and rejects escaping ids', async () => {
    const h = start(); await h.registry.accountsChanged(h.settings()); h.off();
    const orphan = accountDir(h.dataDir, 'probe@orphan'); const kept = accountDir(h.dataDir, 'probe@work');
    mkdirSync(orphan, { recursive: true }); mkdirSync(kept, { recursive: true });
    h.registry.register('probe', h.impl, h.dataDir); await h.registry.accountsChanged(h.settings());
    expect(existsSync(orphan)).toBe(false); expect(existsSync(kept)).toBe(true);
    await expect(removeAccountDir(h.dataDir, 'probe@../outside')).rejects.toThrow();
    expect(() => accountDir(h.dataDir, 'probe@..')).toThrow();
  });
  it('detaches child junctions and refuses a redirected accounts root', async () => {
    const dataDir = tempDir(); const outside = tempDir();
    const marker = join(outside, 'keep.txt'); writeFileSync(marker, 'keep');
    mkdirSync(join(dataDir, ACCOUNTS_DIR));
    const child = accountDir(dataDir, 'probe@a'); symlinkSync(outside, child, 'junction');
    await prepareAccountRemoval(dataDir, 'probe@a'); expect(existsSync(child)).toBe(false); expect(readFileSync(marker, 'utf8')).toBe('keep');
    const redirected = tempDir(); symlinkSync(outside, join(redirected, ACCOUNTS_DIR), 'junction');
    await expect(removeAccountDir(redirected, 'probe@a')).rejects.toThrow('symbolic link');
    expect(readFileSync(marker, 'utf8')).toBe('keep');
  });
  it('retries a failed removal at the next activation', async () => {
    const h = start(); await h.registry.accountsChanged(h.settings());
    const dir = accountDir(h.dataDir, 'probe@work'); mkdirSync(dir, { recursive: true });
    h.impl.removeAccount = vi.fn(async () => { throw new Error('test file lock'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await h.save({ accounts: [] }); expect(existsSync(dir)).toBe(true); expect(warn).toHaveBeenCalled();
      h.off(); h.impl.removeAccount = vi.fn(async () => undefined);
      h.registry.register('probe', h.impl, h.dataDir); await h.registry.accountsChanged(h.settings());
      expect(existsSync(dir)).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

describe('account link sessions', () => {
  it('relays codes, publishes the URL and completes; one session per account', async () => {
    let io!: AccountLinkIo;
    const h = start(async (_account, linking) => { io = linking; linking.open('https://example.test/sign-in'); expect(await linking.code()).toBe('test-code'); });
    h.registry.linkAccount('probe@work');
    expect(() => h.registry.linkAccount('probe@work')).toThrow('already in progress');
    await tick(); expect(io.signal.aborted).toBe(false);
    h.registry.submitLinkCode('probe@work', ' test-code '); await tick();
    expect(h.events.filter((e) => e.type === 'account-link').map((e) => e.state)).toEqual(['waiting', 'waiting', 'done']);
    expect(h.events[1]).toMatchObject({ url: 'https://example.test/sign-in' });
    expect(() => h.registry.submitLinkCode('probe@work', 'late')).toThrow('No sign-in');
  });
  it('reports failure and allows a fresh attempt', async () => {
    const h = start(async () => { throw new Error('test failure'); });
    h.registry.linkAccount('probe@work'); await tick();
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', error: 'test failure' });
    h.registry.linkAccount('probe@work'); await tick();
    expect(h.events.filter((e) => e.type === 'account-link' && e.state === 'failed')).toHaveLength(2);
  });
  it.each(['cancel', 'off', 'remove'])('aborts a stalled provider on %s and ignores late completion', async (reason) => {
    let io!: AccountLinkIo; let finish!: () => void;
    const h = start(async (_account, linking) => { io = linking; await new Promise<void>((resolve) => { finish = resolve; }); });
    h.registry.linkAccount('probe@work'); await tick();
    if (reason === 'cancel') h.registry.cancelLink('probe@work');
    else if (reason === 'off') h.off();
    else await h.save({});
    await tick(); expect(io.signal.aborted).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', error: 'Sign-in cancelled.' });
    finish(); await tick(); expect(h.events.at(-1)).toMatchObject({ state: 'failed' });
  });
});
