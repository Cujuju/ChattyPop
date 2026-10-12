import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_INVOKE } from '@shared/contract';
import type { CoreClient } from '../src/main/coreClient';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const files = new Map<string, string>();
const steps: string[] = [];
const requireSecretStorage = vi.fn(() => { steps.push('encryption'); });
vi.mock('../src/main/ipc/mainCalls', () => ({ handleMain: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) }));
vi.mock('../src/main/secretFile', () => ({
  requireSecretStorage,
  SECRET_FILES: {
    read: (name: string) => files.get(name) ?? null,
    write: (name: string, value: string) => { steps.push('store'); files.set(name, value); },
    delete: (name: string) => files.delete(name),
  },
}));
vi.mock('../src/main/openrouterAuth', () => ({ checkOpenRouterKey: vi.fn(), signInToOpenRouter: vi.fn() }));
vi.mock('../src/main/openrouterKeys', () => ({ loadOpenRouterKeys: () => [], addOpenRouterKey: vi.fn(), removeOpenRouterKey: vi.fn(), updateOpenRouterKey: vi.fn() }));
vi.mock('../src/main/typesafeKey', () => ({ loadTypeSafeKey: () => null, saveTypeSafeKey: vi.fn(), forgetTypeSafeKey: vi.fn() }));
const { registerKeyHandlers } = await import('../src/main/ipc/keys');
const { PROVIDER_KEYS_FILE } = await import('../src/main/providerKeys');

beforeEach(() => { handlers.clear(); files.clear(); steps.length = 0; requireSecretStorage.mockReset().mockImplementation(() => { steps.push('encryption'); }); });

function start(check: (id: string, key: string) => Promise<void> = async () => undefined) {
  const call = vi.fn(async (method: string, ...args: unknown[]) => {
    if (method === 'checkProviderApiKey') { steps.push('check'); await check(args[0] as string, args[1] as string); }
    if (method === 'setProviderApiKeys') steps.push('deliver');
  });
  registerKeyHandlers({ call } as unknown as CoreClient);
  steps.length = 0;
  return call;
}
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args);

describe('main owns provider credentials', () => {
  it('leaves startup delivery to CoreInit and checks trimmed keys before persistence and core delivery', async () => {
    files.set(PROVIDER_KEYS_FILE, '{"other":"test-other"}');
    const check = vi.fn(async (_id: string, _key: string) => undefined);
    const call = start(check);
    expect(call).not.toHaveBeenCalled();
    await invoke(MAIN_INVOKE.providerKeys.setKey, 'probe@api', ' test-key ');
    expect(steps).toEqual(['encryption', 'check', 'store', 'deliver']);
    expect(check).toHaveBeenCalledWith('probe@api', 'test-key');
    expect(call).toHaveBeenLastCalledWith('setProviderApiKeys', { 'probe@api': 'test-key', other: 'test-other' });
    expect(JSON.parse(files.get(PROVIDER_KEYS_FILE)!)).toEqual({ 'probe@api': 'test-key', other: 'test-other' });
    await invoke(MAIN_INVOKE.providerKeys.removeKey, 'probe@api');
    expect(call).toHaveBeenLastCalledWith('setProviderApiKeys', { other: 'test-other' });
  });
  it('unavailable OS encryption stops before a vendor request', async () => {
    const check = vi.fn(async () => undefined);
    start(check);
    requireSecretStorage.mockImplementation(() => { throw new Error('OS encryption unavailable'); });
    await expect(invoke(MAIN_INVOKE.providerKeys.setKey, 'probe@api', 'test-key')).rejects.toThrow('OS encryption unavailable');
    expect(check).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });
  it('a rejected key preserves the encrypted copy and core state', async () => {
    files.set(PROVIDER_KEYS_FILE, '{"probe@api":"test-existing"}');
    const call = start(async () => { throw new Error('rejected'); });
    await expect(invoke(MAIN_INVOKE.providerKeys.setKey, 'probe@api', 'test-key')).rejects.toThrow('rejected');
    expect(steps).toEqual(['encryption', 'check']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(files.get(PROVIDER_KEYS_FILE)).toBe('{"probe@api":"test-existing"}');
  });
  it('rejects blank keys before checking or storage', async () => {
    start();
    await expect(invoke(MAIN_INVOKE.providerKeys.setKey, 'probe@api', ' ')).rejects.toThrow('Paste an API key');
    expect(steps).toEqual([]);
  });
});
