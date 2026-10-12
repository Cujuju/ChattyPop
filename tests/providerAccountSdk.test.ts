import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';

const plugin = definePlugin({ manifest: { id: 'accountprobe', name: 'Account probe', version: '1', description: '' }, providers: [
  { id: 'accountprobe', label: 'Account probe', displayName: 'Account probe', enabledByDefault: true, accounts: { signIn: true } },
] });

describe('SDK account testing', () => {
  it('seeds account records before activation and drives the host link session', async () => {
    let context!: CoreContext<typeof plugin>;
    let signedIn = false;
    const core = defineCorePlugin(plugin, (ctx) => {
      context = ctx;
      ctx.ai.registerProvider('accountprobe', {
        create: (_choice, account) => ({ id: account.id, maxInputChars: 1, complete: async () => ({ text: account.id }), listModels: async () => [] }),
        status: async () => ({ available: signedIn, detail: signedIn ? 'Signed in' : 'Not signed in', signedIn, models: [] }),
        linkAccount: async (_account, io) => { io.open('https://example.test/login'); signedIn = await io.code() === 'test-code'; },
      });
    });
    const h = testPlugin(core, { ai: { accounts: [{ id: 'accountprobe@work', auth: 'signIn' }] } });
    try {
      expect(context.ai.providers().map((p) => p.id)).toEqual(['accountprobe', 'accountprobe@work']);
      h.ai.linkAccount('accountprobe@work');
      h.ai.submitLinkCode('accountprobe@work', 'test-code');
      await vi.waitFor(() => expect(h.ai.linkEvents().at(-1)?.state).toBe('done'));
      expect(h.ai.linkEvents()).toContainEqual(expect.objectContaining({ url: 'https://example.test/login', state: 'waiting' }));
      const provider = context.ai.provider('accountprobe@work');
      expect(provider.id).toBe('accountprobe@work');
      expect(await provider.complete({ system: '', prompt: '', reads: [] })).toEqual({ text: 'accountprobe@work' });
    } finally { await h.dispose(); }
  });
});
