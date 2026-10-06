// Desktop test-window clients use SDK implementations, exclude phone-only members, and stamp calls with the desktop audience.
import { describe, expect, it, onTestFinished } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';

interface Calls {
  both(): string;
  desktopOnly(): string;
  phoneOnly(): string;
}
const probe = definePlugin({
  manifest: { id: 'windowprobe', name: 'Window probe', version: '1', description: '' },
  channels: defineChannels<{ core: Calls }>()({
    core: { both: { audiences: ['renderer', 'phone'], writes: false }, desktopOnly: ['renderer'], phoneOnly: { audiences: ['phone'], writes: false } },
  }),
});
type Clients = Record<'coreClient' | 'desktopCoreClient' | 'phoneCoreClient', (p: typeof probe) => Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>>;
// Renderer modules: imported by path so the node type-check doesn't follow them.
const windowPath = '../src/plugin-sdk/renderer/testing';
const clientsPath = '../src/plugin-sdk/renderer/clients';

describe('a desktop test window', () => {
  it('lacks the phone-only member, and core refuses it as a desktop call', async () => {
    const t = testPlugin(defineCorePlugin(probe, (ctx) => ctx.channels.serve({ both: () => 'both', desktopOnly: () => 'desktop', phoneOnly: () => 'phone' })));
    onTestFinished(() => t.dispose());
    const { testWindow } = (await import(windowPath)) as { testWindow(o: { audience: 'renderer'; core: typeof t }): unknown };
    testWindow({ audience: 'renderer', core: t });
    const c = (await import(clientsPath)) as Clients;
    const client = c.coreClient(probe);
    expect(['both', 'desktopOnly', 'phoneOnly'].filter((m) => typeof client[m] === 'function')).toEqual(['both', 'desktopOnly']);
    await expect(client.both!()).resolves.toBe('both');
    await expect(client.desktopOnly!()).resolves.toBe('desktop');
    // The phone's client, used from a desktop window anyway: its call still arrives stamped as the desktop's.
    await expect(c.phoneCoreClient(probe).phoneOnly!()).rejects.toThrow('Plugin windowprobe has no function phoneOnly for renderer');
  });
});
