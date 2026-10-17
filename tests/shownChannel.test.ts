import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { APP_EVENT_CHANNEL, GET_SHOWN_CHANNEL_CHANNEL, SHOWN_CHANNEL_CHANNEL, type AppEvent, type RendererApi } from '@shared/contract';
import { DESKTOP_SHELL_GLOBAL, SHELL_CHANNELS, SHELL_ORIGIN_ARG, type DesktopShell } from '@shared/desktopShell';
import type { ServerWindow, ServerWindows } from '../src/main/client/serverWindows';

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (e: IpcMainEvent, value: unknown) => void>(),
  handlers: new Map<string, (e: IpcMainInvokeEvent) => unknown>(),
  exposed: new Map<string, unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (e: IpcMainEvent, value: unknown) => void) => ipc.listeners.set(channel, listener),
    handle: (channel: string, handler: (e: IpcMainInvokeEvent) => unknown) => ipc.handlers.set(channel, handler),
  },
  ipcRenderer: { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => ipc.exposed.set(key, api) },
  BrowserWindow: class {},
  app: { getPath: () => '', getName: () => 'ChattyPop' },
  screen: {},
  session: {},
  shell: {},
  dialog: {},
  nativeImage: {},
  Notification: {},
}));

const { registerShownChannelHandlers } = await import('../src/main/shownChannel');
const { registerShellHandlers } = await import('../src/main/client/shellHandlers');
const { PageCommands } = await import('../src/main/client/serverWindows');

const CHANNEL = '200000000000000001';
const NEXT_CHANNEL = '200000000000000002';
const ORIGIN = 'https://one.example';
const OTHER_ORIGIN = 'https://two.example';
const INVALID = [undefined, false, 1, {}, [], { channelId: CHANNEL }];
const window = (): BrowserWindow => ({ webContents: { send: vi.fn() }, isDestroyed: () => false }) as unknown as BrowserWindow;
const event = (win: BrowserWindow): IpcMainEvent & IpcMainInvokeEvent => ({ sender: win.webContents }) as IpcMainEvent & IpcMainInvokeEvent;
const report = (channel: string, win: BrowserWindow, value: unknown): void => ipc.listeners.get(channel)!(event(win), value);
const read = (channel: string, win: BrowserWindow): unknown => ipc.handlers.get(channel)!(event(win));

beforeEach(() => {
  ipc.listeners.clear();
  ipc.handlers.clear();
  ipc.exposed.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('the local shown-channel contract', () => {
  function setup() {
    const main = window();
    const panels = [window(), window()];
    registerShownChannelHandlers(main, { windows: () => panels });
    return { main, panels };
  }

  it('sends main-window changes and null to every open panel', () => {
    const { main, panels } = setup();
    for (const channelId of [CHANNEL, NEXT_CHANNEL, null]) {
      report(SHOWN_CHANNEL_CHANNEL, main, channelId);
      for (const panel of panels) expect(panel.webContents.send).toHaveBeenLastCalledWith(APP_EVENT_CHANNEL, { type: 'shown-channel', channelId });
    }
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it('answers a newly opened or reloaded panel with the current channel', () => {
    const { main, panels } = setup();
    expect(read(GET_SHOWN_CHANNEL_CHANNEL, panels[0]!)).toBeNull();
    report(SHOWN_CHANNEL_CHANNEL, main, CHANNEL);
    const added = window();
    panels.push(added);
    expect(read(GET_SHOWN_CHANNEL_CHANNEL, added)).toBe(CHANNEL);
    report(SHOWN_CHANNEL_CHANNEL, main, NEXT_CHANNEL);
    expect(read(GET_SHOWN_CHANNEL_CHANNEL, added)).toBe(NEXT_CHANNEL);
    expect(read(GET_SHOWN_CHANNEL_CHANNEL, window())).toBeNull();
  });

  it('ignores malformed payloads and reports from panels or unknown windows', () => {
    const { main, panels } = setup();
    report(SHOWN_CHANNEL_CHANNEL, main, CHANNEL);
    for (const value of INVALID) report(SHOWN_CHANNEL_CHANNEL, main, value);
    report(SHOWN_CHANNEL_CHANNEL, panels[0]!, NEXT_CHANNEL);
    report(SHOWN_CHANNEL_CHANNEL, window(), null);
    expect(read(GET_SHOWN_CHANNEL_CHANNEL, panels[0]!)).toBe(CHANNEL);
    for (const panel of panels) expect(panel.webContents.send).toHaveBeenCalledTimes(1);
  });
});

describe('the client shell shown-channel contract', () => {
  function setup() {
    const entries: ServerWindow[] = [];
    const commands = new Map<BrowserWindow, InstanceType<typeof PageCommands>>();
    const add = (origin: string, panel: string | null): BrowserWindow => {
      const win = window();
      entries.push({ win, origin, panel });
      commands.set(win, new PageCommands((e) => win.webContents.send(APP_EVENT_CHANNEL, e)));
      return win;
    };
    const windows = {
      of: (wc) => entries.find((w) => w.win.webContents === wc),
      all: () => entries.map((w) => w.win),
      command: (win, e) => commands.get(win)!.send(e),
      listening: (wc) => {
        const win = entries.find((w) => w.win.webContents === wc)?.win;
        if (win) commands.get(win)!.listen();
      },
    } satisfies Pick<ServerWindows, 'of' | 'all' | 'command' | 'listening'>;
    registerShellHandlers(windows as ServerWindows);
    return { add, windows, commands };
  }

  it('keeps each server separate, delivers to every panel, and queues until the page listens', () => {
    const { add, windows } = setup();
    const main = add(ORIGIN, null);
    const panels = [add(ORIGIN, 'probe'), add(ORIGIN, 'other-probe')];
    const otherMain = add(OTHER_ORIGIN, null);
    const otherPanel = add(OTHER_ORIGIN, 'probe');
    report(SHELL_CHANNELS.reportShownChannel, main, CHANNEL);
    report(SHELL_CHANNELS.reportShownChannel, otherMain, NEXT_CHANNEL);
    for (const panel of [...panels, otherPanel]) {
      expect(panel.webContents.send).not.toHaveBeenCalled();
      windows.listening(panel.webContents);
    }
    for (const panel of panels) expect(panel.webContents.send).toHaveBeenCalledExactlyOnceWith(APP_EVENT_CHANNEL, { type: 'shown-channel', channelId: CHANNEL });
    expect(otherPanel.webContents.send).toHaveBeenCalledExactlyOnceWith(APP_EVENT_CHANNEL, { type: 'shown-channel', channelId: NEXT_CHANNEL });
    expect(read(SHELL_CHANNELS.getShownChannel, add(ORIGIN, 'new-probe'))).toBe(CHANNEL);
    expect(read(SHELL_CHANNELS.getShownChannel, otherPanel)).toBe(NEXT_CHANNEL);
    report(SHELL_CHANNELS.reportShownChannel, main, null);
    for (const panel of panels) expect(panel.webContents.send).toHaveBeenLastCalledWith(APP_EVENT_CHANNEL, { type: 'shown-channel', channelId: null });
    expect(read(SHELL_CHANNELS.getShownChannel, panels[0]!)).toBeNull();
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it('ignores invalid payloads and reporters outside a server main window', () => {
    const { add, windows } = setup();
    const main = add(ORIGIN, null);
    const panel = add(ORIGIN, 'probe');
    windows.listening(panel.webContents);
    expect(read(SHELL_CHANNELS.getShownChannel, panel)).toBeNull();
    report(SHELL_CHANNELS.reportShownChannel, main, CHANNEL);
    for (const value of INVALID) report(SHELL_CHANNELS.reportShownChannel, main, value);
    report(SHELL_CHANNELS.reportShownChannel, panel, NEXT_CHANNEL);
    report(SHELL_CHANNELS.reportShownChannel, window(), null);
    expect(read(SHELL_CHANNELS.getShownChannel, panel)).toBe(CHANNEL);
    expect(panel.webContents.send).toHaveBeenCalledTimes(1);
    expect(() => read(SHELL_CHANNELS.getShownChannel, window())).toThrow('Not a server window.');
  });
});

describe('preload shown-channel forwarding', () => {
  it.each([false, true])('reports and reads through the matching channels (client: %s)', async (client) => {
    const argv = process.argv;
    try {
      process.argv = client ? [...argv, `${SHELL_ORIGIN_ARG}${ORIGIN}`] : argv.filter((a) => !a.startsWith(SHELL_ORIGIN_ARG));
      vi.stubGlobal('location', { origin: client ? ORIGIN : 'file://' });
      vi.resetModules();
      await import('../src/preload/index');
      const api = ipc.exposed.get(client ? DESKTOP_SHELL_GLOBAL : 'chattypop') as RendererApi & DesktopShell;
      const { ipcRenderer } = await import('electron');
      const reportChannel = client ? SHELL_CHANNELS.reportShownChannel : SHOWN_CHANNEL_CHANNEL;
      const getChannel = client ? SHELL_CHANNELS.getShownChannel : GET_SHOWN_CHANNEL_CHANNEL;
      api.reportShownChannel(CHANNEL);
      api.reportShownChannel(null);
      expect(ipcRenderer.send).toHaveBeenCalledWith(reportChannel, CHANNEL);
      expect(ipcRenderer.send).toHaveBeenCalledWith(reportChannel, null);
      vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce(CHANNEL);
      await expect(api.getShownChannel()).resolves.toBe(CHANNEL);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(getChannel);
      const received: AppEvent[] = [];
      const off = client ? api.onLocalEvent((e) => received.push(e)) : api.onEvent((e) => received.push(e));
      const push: AppEvent = { type: 'shown-channel', channelId: NEXT_CHANNEL };
      const listener = vi.mocked(ipcRenderer.on).mock.calls.at(-1)![1];
      listener({} as never, push);
      expect(received).toEqual([push]);
      off();
      expect(ipcRenderer.off).toHaveBeenCalledWith(APP_EVENT_CHANNEL, listener);
    } finally {
      process.argv = argv;
    }
  });
});
