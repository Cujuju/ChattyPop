// The Discord view loads the client only once the gateway tap's Network events are on, so the client's gateway socket is seen (#128).
import { describe, expect, it, vi } from 'vitest';

/** The view's page: records its loads; Network.enable settles when the test says. */
const page = vi.hoisted(() => {
  let settle: (ok: boolean) => void = () => undefined;
  return {
    loads: [] as string[],
    url: 'about:blank',
    enable: () => new Promise<void>((resolve, reject) => { settle = (ok) => (ok ? resolve() : reject(new Error('no target'))); }),
    settleEnable: (ok: boolean) => settle(ok),
  };
});

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    id = 1;
    debugger = Object.assign(new Emitter(), { attach: () => undefined, isAttached: () => true, sendCommand: (method: string) => (method === 'Network.enable' ? page.enable() : Promise.resolve({})) });
    loadURL = async (url: string): Promise<void> => { page.loads.push(url); page.url = url; };
    getURL = (): string => page.url;
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
});
