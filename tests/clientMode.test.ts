// Client mode (main/client): the servers it keeps, the page and session each server's windows get, and the preload
// that gives the desktop shell to that server's pages and no other.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_ERROR_CHANNEL, type AppEvent, type RendererApi } from '@shared/contract';
import type { DesktopShell } from '@shared/desktopShell';

const electron = vi.hoisted(() => ({ exposed: [] as [string, unknown][] }));
vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {},
  screen: {},
  shell: {},
  ipcMain: { on: () => undefined, handle: () => undefined },
  ipcRenderer: { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void electron.exposed.push([key, api]) },
  app: { getPath: () => '' },
}));

const { ServerList } = await import('../src/main/client/servers');
const { PageCommands, serverPageUrl, serverPartition } = await import('../src/main/client/serverWindows');
const { CONNECT_GLOBAL, CONNECT_PAGE_ARG, DESKTOP_SHELL_API_VERSION, DESKTOP_SHELL_GLOBAL, SHELL_CHANNELS, SHELL_ORIGIN_ARG } = await import('@shared/desktopShell');

function memory(text: string | null = null) {
  const store = { text, read: () => store.text, write: (t: string) => void (store.text = t) };
  return store;
}

describe('saved servers', () => {
  it('saves https servers by origin, most recently used first, each once', () => {
    const list = new ServerList(memory());
    expect(list.last()).toBeNull();
    expect(list.add('pc.tail1.ts.net:8443', 1)).toBe('https://pc.tail1.ts.net:8443');
    list.add('https://mac.tail1.ts.net:8443/desktop?panel=alerts', 2);
    list.add('pc.tail1.ts.net:8443', 3);
    expect(list.list().map((s) => s.origin)).toEqual(['https://pc.tail1.ts.net:8443', 'https://mac.tail1.ts.net:8443']);
    expect(list.last()).toBe('https://pc.tail1.ts.net:8443');
    list.remove('https://pc.tail1.ts.net:8443');
    expect(list.last()).toBe('https://mac.tail1.ts.net:8443');
  });

  it('refuses anything but an https server', () => {
    const list = new ServerList(memory());
    expect(() => list.add('http://pc:8443')).toThrow(/https/);
    expect(() => list.add('')).toThrow(/https/);
    expect(list.list()).toEqual([]);
  });

  it('keeps what it saved across starts, and drops entries it can’t trust', () => {
    const store = memory();
    new ServerList(store).add('pc.tail1.ts.net', 5);
    expect(new ServerList(store).list()).toEqual([{ origin: 'https://pc.tail1.ts.net', lastUsedAt: 5 }]);
    store.text = JSON.stringify([{ origin: 'http://evil', lastUsedAt: 1 }, { origin: 'https://ok.example', lastUsedAt: 2 }, 'junk']);
    expect(new ServerList(store).list()).toEqual([{ origin: 'https://ok.example', lastUsedAt: 2 }]);
    store.text = '{not json';
    expect(new ServerList(store).list()).toEqual([]);
  });
});

describe('server windows', () => {
  it("load the server's desktop page, or one panel of it", () => {
    expect(serverPageUrl('https://pc.tail1.ts.net:8443', null)).toBe('https://pc.tail1.ts.net:8443/desktop');
    expect(serverPageUrl('https://pc.tail1.ts.net:8443', 'alerts')).toBe('https://pc.tail1.ts.net:8443/desktop?panel=alerts');
  });

  it('keep each server’s pairing in a session of its own', () => {
    const a = serverPartition('https://a.example');
    expect(a).toMatch(/^persist:server-[0-9a-f]{16}$/);
    expect(serverPartition('https://a.example')).toBe(a);
    expect(serverPartition('https://b.example')).not.toBe(a);
  });

  it('hold a command until the page listens for it, and again while a new document loads', () => {
    const got: AppEvent[] = [];
    const commands = new PageCommands((e) => void got.push(e));
    const open = (channelId: string): AppEvent => ({ type: 'open-message', channelId });
    commands.send(open('1'));
    commands.send(open('2'));
    expect(got).toEqual([]);
    commands.listen();
    expect(got).toEqual([open('1'), open('2')]);
    commands.send(open('3'));
    expect(got).toHaveLength(3);
    commands.reset();
    commands.send(open('4'));
    expect(got).toHaveLength(3);
    commands.listen();
    expect(got).toEqual([open('1'), open('2'), open('3'), open('4')]);
  });
});

describe("a server window's preload", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.unstubAllGlobals();
    electron.exposed.length = 0;
    vi.resetModules();
  });

  async function load(server: string, page: string): Promise<[string, unknown][]> {
    process.argv = [...argv, `${SHELL_ORIGIN_ARG}${server}`];
    vi.stubGlobal('location', { origin: page });
    await import('../src/preload/index');
    return electron.exposed;
  }

  it('gives the shell to the server it opened on', async () => {
    const exposed = await load('https://pc.tail1.ts.net:8443', 'https://pc.tail1.ts.net:8443');
    expect(exposed.map(([key]) => key)).toEqual([DESKTOP_SHELL_GLOBAL]);
    expect((exposed[0]![1] as { apiVersion: number }).apiVersion).toBe(DESKTOP_SHELL_API_VERSION);
  });

  it('tells the app the page listens for commands only once one can reach it', async () => {
    const exposed = await load('https://pc.tail1.ts.net:8443', 'https://pc.tail1.ts.net:8443');
    const { ipcRenderer } = await import('electron');
    const on = vi.mocked(ipcRenderer.on);
    const send = vi.mocked(ipcRenderer.send);
    expect(send).not.toHaveBeenCalledWith(SHELL_CHANNELS.listening);
    (exposed[0]![1] as DesktopShell).onLocalEvent(() => undefined);
    expect(send).toHaveBeenCalledWith(SHELL_CHANNELS.listening);
    expect(on.mock.invocationCallOrder.at(-1)!).toBeLessThan(send.mock.invocationCallOrder.at(-1)!);
  });

  it('gives nothing to a page anywhere else, not even the app’s API', async () => {
    expect(await load('https://pc.tail1.ts.net:8443', 'https://evil.example')).toEqual([]);
  });

  it("gives the app's own windows the renderer API, and the connect page the server list", async () => {
    vi.stubGlobal('location', { origin: 'file://' });
    await import('../src/preload/index');
    expect(electron.exposed.map(([key]) => key)).toEqual(['chattypop']);
    electron.exposed.length = 0;
    vi.resetModules();
    process.argv = [...argv, CONNECT_PAGE_ARG];
    await import('../src/preload/index');
    expect(electron.exposed.map(([key]) => key)).toEqual([CONNECT_GLOBAL]);
  });

  it('sends local page errors once over desktop IPC', async () => {
    vi.stubGlobal('location', { origin: 'file://' });
    await import('../src/preload/index');
    const { ipcRenderer } = await import('electron');
    const send = vi.mocked(ipcRenderer.send);
    send.mockClear();
    const report = { page: '12345678-1234-1234-1234-123456789abc', at: 0, kind: 'error', message: 'boom', stack: '' } as const;
    (electron.exposed.find(([key]) => key === 'chattypop')![1] as RendererApi).reportPageError(report);
    expect(send).toHaveBeenCalledExactlyOnceWith(PAGE_ERROR_CHANNEL, report);
  });
});
