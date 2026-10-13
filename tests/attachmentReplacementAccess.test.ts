import { describe, expect, it, vi } from 'vitest';
import type { RendererApi } from '@shared/contract';
import { MAIN_INVOKE } from '@shared/types/ipc';
import { phoneMayCallMain } from '@shared/phone';
import { remoteMayCallMain } from '@shared/remote';

const REMOTE_MODULE = '../src/plugin-sdk/renderer/shell/remoteApi';
const PHONE_MODULE = '../src/plugin-sdk/renderer/shell/phoneApi';
const { createRemoteRendererApi } = await import(REMOTE_MODULE) as { createRemoteRendererApi(transport: unknown, shell: null): RendererApi };
const { createPhoneRendererApi } = await import(PHONE_MODULE) as { createPhoneRendererApi(transport: unknown): RendererApi };
const REPLACEMENT_CALLS = ['beginReplacement', 'replacementChunk', 'finishReplacement', 'abortReplacement'] as const;

describe('local replacement access', () => {
  it.each(REPLACEMENT_CALLS)('refuses %s at both transport gates', (method) => {
    expect(remoteMayCallMain(MAIN_INVOKE.media[method])).toBe(false);
    expect(phoneMayCallMain(MAIN_INVOKE.media[method])).toBe(false);
  });

  it.each(['remote', 'phone'] as const)('%s APIs refuse replacement before sending a transport call', async (surface) => {
    const transport = { call: vi.fn(), listen: vi.fn(), notifications: vi.fn() };
    const api = surface === 'remote' ? createRemoteRendererApi(transport, null) : createPhoneRendererApi(transport);
    const message = surface === 'remote' ? 'server' : 'desktop';
    await expect(api.media.beginReplacement('300000000000000001', 'webp')).rejects.toThrow(message);
    await expect(api.media.replacementChunk('token', 0, new Uint8Array())).rejects.toThrow(message);
    await expect(api.media.finishReplacement('token')).rejects.toThrow(message);
    await expect(api.media.abortReplacement('token')).rejects.toThrow(message);
    expect(transport.call).not.toHaveBeenCalled();
  });
});
