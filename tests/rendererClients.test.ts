// Renderer core clients (docs/plugin-architecture.md §5): a window's client holds only the members its audience serves,
// and a plugin resource reads as its fallback once the plugin turns off, whenever core's answer arrives.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { reader, type RangeQuery } from './p2Fixtures';

// The client runtime, so effects and resources react as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
// The build includes the reader plugin, so the registry knows its calls' audiences.
vi.mock('virtual:bundled-plugins/shared', async () => ({ default: [(await import('./p2Fixtures')).reader], catalog: null }));

type Answer = { status: 'ok'; value: unknown } | { status: 'inactive'; pluginId: string };
const env = vi.hoisted(() => ({
  on: true,
  emit: null as null | ((e: { type: string }) => void),
  /** Core's answers not yet given, oldest first. */
  pending: [] as ((answer: Answer) => void)[],
  /** Each call's argument tuple, oldest first. */
  sent: [] as unknown[][],
}));

/** A desktop window's API: the plugin list says whether the reader plugin is on; core answers when the test says. */
const desktop = {
  onEvent: (listener: (e: { type: string }) => void) => {
    env.emit = listener;
    return () => undefined;
  },
  core: { plugins: async () => [{ id: reader.manifest.id, bundled: true, status: env.on ? 'active' : 'disabled' }] },
  plugins: {
    callCore: (_id: string, _name: string, args: unknown[]) => {
      env.sent.push(args);
      return new Promise<Answer>((resolve) => env.pending.push(resolve));
    },
  },
};
vi.stubGlobal('window', { chattypop: desktop });

/** Lets awaited continuations and resource loads run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
/** Turns the reader plugin on or off, as Settings → Plugins does: core's list changes and windows hear it. */
async function setReaderOn(on: boolean): Promise<void> {
  env.on = on;
  env.emit!({ type: 'plugins-changed' });
  await settle();
}
/** Core answers the oldest call still waiting. */
async function answer(a: Answer): Promise<void> {
  env.pending.shift()!(a);
  await settle();
}

interface ProbeCalls {
  both(): string;
  desktopOnly(): string;
  phoneOnly(): string;
}
const probe = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  channels: defineChannels<{ core: ProbeCalls }>()({ core: { both: { audiences: ['renderer', 'phone'], writes: false }, desktopOnly: ['renderer'], phoneOnly: { audiences: ['phone'], writes: false } } }),
});
type Clients = Record<'coreClient' | 'desktopCoreClient' | 'phoneCoreClient', (p: typeof probe) => Record<string, unknown>>;
// Renderer modules: imported by path so the node type-check doesn't follow them.
const clientsPath = '../src/plugin-sdk/renderer/clients';
const resourcePath = '../src/plugin-sdk/renderer/resource';
const membersOf = (client: Record<string, unknown>): string[] => ['both', 'desktopOnly', 'phoneOnly'].filter((m) => typeof client[m] === 'function');

describe('core clients', () => {
  it("hold only the members the window's audience serves", async () => {
    const c = (await import(clientsPath)) as Clients;
    expect(membersOf(c.desktopCoreClient(probe))).toEqual(['both', 'desktopOnly']);
    expect(membersOf(c.phoneCoreClient(probe))).toEqual(['both', 'phoneOnly']);
    // A desktop window: the preload's API is there.
    expect(membersOf(c.coreClient(probe))).toEqual(['both', 'desktopOnly']);
    // The phone's page: no preload.
    vi.stubGlobal('window', {});
    try {
      expect(membersOf(c.coreClient(probe))).toEqual(['both', 'phoneOnly']);
    } finally {
      vi.stubGlobal('window', { chattypop: desktop });
    }
  });
});

describe('pluginResource', () => {
  it('reads as its fallback when the plugin turns off mid-read, whichever arrives first: the answer or the switch', async () => {
    const { createRoot } = await import('solid-js');
    const { pluginResource } = (await import(resourcePath)) as {
      pluginResource(p: typeof reader, member: 'read', args: () => [RangeQuery], fallback: null): {
        (): unknown;
        readonly failure: string | null;
        refetch(): Promise<void>;
      };
    };
    const query: RangeQuery = { scope: 'all' };
    const r = createRoot(() => pluginResource(reader, 'read', () => [query], null));
    await settle();
    await answer({ status: 'ok', value: 'first' });
    expect(r()).toBe('first');

    // The switch first: the window hears the plugin stop, then core's late answer arrives.
    void r.refetch();
    await settle();
    await setReaderOn(false);
    expect(r()).toBeNull();
    await answer({ status: 'ok', value: 'late' });
    expect(r()).toBeNull();
    expect(r.failure).toBeNull();

    // The answer first: core had stopped the plugin before the window heard.
    await setReaderOn(true);
    await answer({ status: 'ok', value: 'again' });
    expect(r()).toBe('again');
    void r.refetch();
    await settle();
    await answer({ status: 'inactive', pluginId: reader.manifest.id });
    expect(r()).toBeNull();
    expect(r.failure).toBeNull();
  });

  it('reads its arguments again on refetch, so a rolling window a refresh asks for ends now', async () => {
    const { createRoot } = await import('solid-js');
    const { pluginResource } = (await import(resourcePath)) as {
      pluginResource(p: typeof reader, member: 'read', args: () => [RangeQuery], fallback: null): { refetch(): Promise<void> };
    };
    let clock = 1_000; // untracked, as Date.now() is
    const r = createRoot(() => pluginResource(reader, 'read', () => [{ sinceTs: clock }], null));
    await settle();
    await answer({ status: 'ok', value: 'first' });
    clock = 2_000;
    void r.refetch();
    await settle();
    await answer({ status: 'ok', value: 'second' });
    expect(env.sent.slice(-2).map(([q]) => (q as RangeQuery).sinceTs)).toEqual([1_000, 2_000]);
  });
});
