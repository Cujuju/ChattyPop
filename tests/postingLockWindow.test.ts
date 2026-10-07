// Window posting stays locked until the plugin list arrives. Enabled unlocking plugins release it; outbox adoption waits for unlock.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid’s browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  manifest: (id: string) => ({ id, name: id, version: '1.0.0', description: '' }),
  setLoaded: (_on: boolean): void => undefined,
  setOn: (_ids: string[]): void => undefined,
  idbReads: [] as string[],
}));
vi.mock('virtual:bundled-plugins/shared', () => ({
  default: [{ manifest: env.manifest('unlocker'), unlocks: { posting: true } }, { manifest: env.manifest('plain') }],
  catalog: null,
}));
vi.mock('../src/renderer/src/state/plugins', async () => {
  const { createRequire: req } = await import('node:module');
  const { createSignal } = req(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  const [loaded, setLoaded] = createSignal(false);
  const [on, setOn] = createSignal<string[]>([]);
  env.setLoaded = (v) => void setLoaded(v);
  env.setOn = (ids) => void setOn(ids);
  return {
    pluginsLoaded: loaded,
    plugins: () => (loaded() ? on().map((id) => ({ id, bundled: true, status: 'active' })) : []),
    // Optimistic before the list arrives, as the SDK's is: the lock must not follow it.
    pluginActive: () => true,
  };
});
vi.mock('@/api', () => ({ api: { discord: { send: async () => undefined } } }));
vi.mock('@/ui/format', () => ({ errorText: String }));
vi.mock('@/ui/idbStore', () => ({
  idbEntries: async (prefix: string) => {
    env.idbReads.push(prefix);
    return [];
  },
  idbSet: () => undefined,
  whenWritten: async () => undefined,
}));
vi.mock('../src/renderer/src/state/drafts', () => ({ restoreDraft: () => false }));
// The chat settings store subscribes to app events on import; this test reads only their defaults.
vi.mock('../src/renderer/src/state/chatSettings', async () => {
  const { DEFAULT_DEVICE_CHAT_SETTINGS, DEFAULT_DISCORD_CHAT_SETTINGS } = await import('@shared/chatSettings');
  return { deviceChatSettings: () => DEFAULT_DEVICE_CHAT_SETTINGS, discordChatSettings: () => DEFAULT_DISCORD_CHAT_SETTINGS };
});
// No Web Locks here: the outbox reads every saved queue directly once it takes them over.
vi.stubGlobal('navigator', {});
vi.stubGlobal('window', { addEventListener: () => undefined });

// Renderer modules: imported by path so the node type-check doesn't follow them.
const postingPath = '../src/renderer/src/state/posting';
const outboxPath = '../src/renderer/src/state/outbox';
const { postingUnlocked } = (await import(postingPath)) as { postingUnlocked(): boolean };
await import(outboxPath);
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('the posting lock in a window', () => {
  it('locked until the list arrives, unlocked while the unlocking plugin is on, locked again when it turns off', async () => {
    env.setOn(['unlocker']);
    expect(postingUnlocked()).toBe(false);
    env.setOn(['plain']);
    env.setLoaded(true);
    expect(postingUnlocked()).toBe(false);
    await settled();
    // The outbox hasn't taken over left-over queues while locked.
    expect(env.idbReads).toEqual([]);
    env.setOn(['plain', 'unlocker']);
    expect(postingUnlocked()).toBe(true);
    await settled();
    expect(env.idbReads).toEqual(['outbox:']);
    env.setOn(['plain']);
    expect(postingUnlocked()).toBe(false);
    // Once per page: unlocking again takes nothing over a second time.
    env.setOn(['unlocker']);
    await settled();
    expect(env.idbReads).toEqual(['outbox:']);
  });
});
