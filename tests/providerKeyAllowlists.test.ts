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
    await api.providerKeys.setKey('probe', 'test-key');
    await api.providerKeys.removeKey('probe');
    expect(calls).toEqual([
      { group: 'main', method: MAIN_INVOKE.providerKeys.setKey, params: ['probe', 'test-key'] },
      { group: 'main', method: MAIN_INVOKE.providerKeys.removeKey, params: ['probe'] },
    ]);
  });
  it.each(['setProviderApiKeys', 'checkProviderApiKey', 'setTypeSafeKey'])('%s stays main-only', (method) => {
    expect(RENDERER_CORE_METHODS as readonly string[]).not.toContain(method);
    expect(remoteMayCallCore(method)).toBe(false);
    expect(phoneMayCallCore(method)).toBe(false);
  });
});
