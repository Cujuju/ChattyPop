import { describe, expect, it } from 'vitest';
import { MAIN_INVOKE, RENDERER_CORE_METHODS } from '@shared/contract';
import { phoneMayCallCore, phoneMayCallMain } from '@shared/phone';
import { remoteMayCallCore, remoteMayCallMain } from '@shared/remote';
import { createPhoneRendererApi } from '../src/plugin-sdk/renderer/shell/phoneApi';

describe('provider key transport boundary', () => {
  it('only set/remove main calls cross desktop and phone transports', async () => {
    for (const channel of Object.values(MAIN_INVOKE.providerKeys)) {
      expect(remoteMayCallMain(channel)).toBe(true);
      expect(phoneMayCallMain(channel)).toBe(true);
    }
    const calls: unknown[] = [];
    const api = createPhoneRendererApi({ call: async (request) => { calls.push(request); }, listen: () => () => undefined });
    await api.providerKeys.setKey('probe@api', 'test-key');
    await api.providerKeys.removeKey('probe@api');
    expect(calls).toEqual([
      { group: 'main', method: MAIN_INVOKE.providerKeys.setKey, params: ['probe@api', 'test-key'] },
      { group: 'main', method: MAIN_INVOKE.providerKeys.removeKey, params: ['probe@api'] },
    ]);
  });
  it.each(['setProviderApiKeys', 'checkProviderApiKey', 'setTypeSafeKey', 'setProxyKey'])('%s stays main-only', (method) => {
    expect(RENDERER_CORE_METHODS as readonly string[]).not.toContain(method);
    expect(remoteMayCallCore(method)).toBe(false);
    expect(phoneMayCallCore(method)).toBe(false);
  });
  it('refuses account link controls before the phone sends a call', async () => {
    const call = async (): Promise<never> => { throw new Error('Transport should not run.'); };
    const api = createPhoneRendererApi({ call, listen: () => () => undefined });
    await expect(api.core.linkProviderAccount('probe@work')).rejects.toThrow('only on the desktop');
    await expect(api.core.submitAccountLinkCode('probe@work', 'test-code')).rejects.toThrow('only on the desktop');
    await expect(api.core.cancelAccountLink('probe@work')).rejects.toThrow('only on the desktop');
  });
});
