// ctx.net.fetch has one policy in every process (docs/plugin-architecture.md §3): main reaches the owner-set address
// as core does, read from core's settings per request, and nothing else.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, definePreference, pluginSetting } from '@plugin-sdk/shared';

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { createMainContext } = await import('../src/main/plugins/context');

describe("main's plugin fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reaches the owner-set address as saved now, and refuses the old one', async () => {
    const sent = vi.fn(async (u: URL) => (u.href === 'http://10.0.0.5:11434/api/tags' ? new Response('ok') : new Response(null, { status: 404 })));
    vi.stubGlobal('fetch', sent);
    const owned = definePlugin({
      manifest: { id: 'owned', name: 'Owned', version: '1', description: '' },
      preferences: { settings: definePreference({ default: { url: '' }, normalize: (v: unknown) => ({ url: String((v as { url?: unknown } | null)?.url ?? '') }) }) },
      network: { ownerUrls: [{ setting: 'settings', field: 'url', fallback: 'http://127.0.0.1:11434' }] },
    });
    const saved: Record<string, unknown> = { [pluginSetting(owned, 'settings')]: { url: 'http://10.0.0.5:11434' } };
    const core = { call: async (method: string, key: string) => (method === 'getSetting' ? saved[key] : null) };
    const ctx = createMainContext(owned, { core } as never, {} as never);
    await expect((await ctx.net.fetch('http://10.0.0.5:11434/api/tags')).text()).resolves.toBe('ok');
    await expect(ctx.net.fetch('http://127.0.0.1:11434/api/tags')).rejects.toThrow(/may not fetch/);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
