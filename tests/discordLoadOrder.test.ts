// The Discord view loads the client only once the gateway tap's Network events are on, so the client's gateway socket is seen (#128).
import { describe, expect, it, vi } from 'vitest';

/** The view's page: records its loads; Network.enable settles when the test says. */
const page = vi.hoisted(() => {
  let settle: (ok: boolean) => void = () => undefined;
  return {
    loads: [] as string[],
    url: 'about:blank',
    enables: 0,
    enable: () => new Promise<void>((resolve, reject) => { settle = (ok) => (ok ? resolve() : reject(new Error('no target'))); }),
    settleEnable: (ok: boolean) => settle(ok),
  };
});

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    id = 1;
    debugger = Object.assign(new Emitter(), { attach: () => undefined, isAttached: () => true, sendCommand: (method: string) => (method === 'Network.enable' ? (page.enables++, page.enable()) : Promise.resolve({})) });
    loadURL = async (url: string): Promise<void> => { page.loads.push(url); page.url = url; };
    getURL = (): string => page.url;
    reload = (): void => void page.loads.push('reload');
    isDestroyed = (): boolean => false;
    getOSProcessId = (): number => 0;
    setWindowOpenHandler = (): void => undefined;
    insertCSS = async (): Promise<string> => 'css';
    removeInsertedCSS = async (): Promise<void> => undefined;
  }
  return {
    WebContentsView: class { webContents = new FakeContents(); setVisible(): void {} setBounds(): void {} },
    app: { getPath: () => '' },
    shell: { openExternal: async () => undefined },
  };
});

const { DiscordView } = await import('../src/main/discordView');
const win = { contentView: { addChildView: () => undefined }, getContentSize: () => [800, 600] } as unknown as ConstructorParameters<typeof DiscordView>[0];
/** Lets queued promise continuations run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('Discord view start', () => {
  it.each([['on', true], ['failed to turn on', false]])('loads a blank page, then the client once Network events are %s', async (_name, ok) => {
    page.loads.length = 0;
    new DiscordView(win);
    await settle();
    expect(page.loads).toEqual(['about:blank']);
    page.settleEnable(ok);
    await settle();
    expect(page.loads).toHaveLength(2);
    expect(page.loads[1]).toMatch(/^https:\/\/discord\.com\//);
  });

  it('reconnects by turning failed Network events on again, then reloading the client', async () => {
    page.loads.length = 0;
    const view = new DiscordView(win);
    await settle();
    page.settleEnable(false);
    await settle();
    const enables = page.enables;
    const done = view.reconnect();
    await settle();
    expect(page.enables).toBe(enables + 1);
    expect(page.loads.at(-1)).not.toBe('reload');
    page.settleEnable(true);
    await done;
    expect(page.loads.at(-1)).toBe('reload');
  });

  it('reconnects with Network events on by reloading at once', async () => {
    const view = new DiscordView(win);
    await settle();
    page.settleEnable(true);
    await settle();
    const enables = page.enables;
    await view.reconnect();
    expect(page.enables).toBe(enables);
    expect(page.loads.at(-1)).toBe('reload');
  });
});

describe('gateway tap sockets', () => {
  it('says a gateway socket opened, and ended once the last one closes', async () => {
    const view = new DiscordView(win);
    const changes: string[] = [];
    view.tap.on('gateway', (c) => changes.push(c));
    const cdp = (method: string, params: Record<string, unknown>): boolean => view.webContents.debugger.emit('message', {}, method, params);
    cdp('Network.webSocketCreated', { requestId: 'a', url: 'wss://gateway.discord.gg/?encoding=json&v=9' });
    cdp('Network.webSocketCreated', { requestId: 'other', url: 'wss://example.com/' });
    cdp('Network.webSocketCreated', { requestId: 'b', url: 'wss://gateway-us-east1-b.discord.gg/?encoding=json&v=9' });
    cdp('Network.webSocketClosed', { requestId: 'a' });
    cdp('Network.webSocketClosed', { requestId: 'other' });
    expect(changes).toEqual(['opened', 'opened']);
    cdp('Network.webSocketClosed', { requestId: 'b' });
    expect(changes).toEqual(['opened', 'opened', 'ended']);
  });
});
