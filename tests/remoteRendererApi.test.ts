// A remote desktop's renderer API (@plugin-sdk/renderer/shell remoteApi): window calls travel as a window's, what the
// device does itself goes to the client app's shell, and the browser stands in without one.
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent, RendererApi } from '@shared/contract';
import type { DesktopShell } from '@shared/desktopShell';
import type { DeliveredNotification } from '@shared/notifications';
import type { PhoneCall } from '@shared/phone';

// A renderer module: imported by path so the node type-check doesn't follow it into the DOM.
const remoteApiPath = '../src/plugin-sdk/renderer/shell/remoteApi';
const { createRemoteRendererApi } = (await import(remoteApiPath)) as {
  createRemoteRendererApi(transport: unknown, shell: DesktopShell | null): RendererApi & { openExport?: unknown };
};
const { APP_RESTART_CHANNEL, MAIN_INVOKE } = await import('@shared/contract');
const { setMediaRoot } = await import('@shared/media');
const { DESKTOP_SHELL_API_VERSION, DESKTOP_SHELL_GLOBAL, desktopShell } = await import('@shared/desktopShell');

function transport() {
  const calls: PhoneCall[] = [];
  let deliver: (e: AppEvent) => void = () => undefined;
  let notify: (n: DeliveredNotification) => void = () => undefined;
  const t = {
    calls,
    call: vi.fn(async (c: PhoneCall) => void calls.push(c)),
    listen: vi.fn((d: (e: AppEvent) => void) => void (deliver = d)),
    notifications: vi.fn((d: (n: DeliveredNotification) => void) => void (notify = d)),
    openExport: vi.fn(),
    event: (e: AppEvent) => deliver(e),
    notice: (n: DeliveredNotification) => notify(n),
  };
  return t;
}

function shell() {
  let local: (e: AppEvent) => void = () => undefined;
  const s = {
    apiVersion: DESKTOP_SHELL_API_VERSION,
    notify: vi.fn(),
    setBadge: vi.fn(),
    saveMedia: vi.fn(async () => undefined),
    savePdf: vi.fn(async () => undefined),
    openPanelWindow: vi.fn(),
    showInMainWindow: vi.fn(),
    setUnsaved: vi.fn(),
    discardUnsaved: vi.fn(),
    onLocalEvent: vi.fn((l: (e: AppEvent) => void) => {
      local = l;
      return () => undefined;
    }),
    command: (e: AppEvent) => local(e),
  } satisfies DesktopShell & { command(e: AppEvent): void };
  return s;
}

const notice: DeliveredNotification = { title: 't', body: 'b', target: { kind: 'message', channelId: 'c', messageId: 'm' }, kind: 'plugin' };

describe('remote desktop calls', () => {
  it('sends core, Discord and plugin calls as a window makes them, and main calls by channel', async () => {
    const t = transport();
    const api = createRemoteRendererApi(t, null);
    await api.core.setSetting('k', 1);
    await api.discord.setOptIn('c', true);
    await api.plugins.callCore('relay', 'go', [1]);
    await api.storage.info();
    await api.restartApp();
    expect(t.calls).toEqual([
      { group: 'core', method: 'setSetting', params: ['k', 1] },
      { group: 'discord', method: 'setOptIn', params: ['c', true] },
      { group: 'plugins', method: 'callCore', params: ['relay', 'go', [1]] },
      { group: 'main', method: MAIN_INVOKE.storage.info, params: [] },
      { group: 'main', method: APP_RESTART_CHANNEL, params: [] },
    ]);
  });

  it("keeps the live pane here and refuses what needs the server's screen", async () => {
    const t = transport();
    const api = createRemoteRendererApi(t, null);
    api.discord.setSlot({ visible: true, x: 0, y: 0, width: 1, height: 1 });
    api.discord.openChannel('g', 'c');
    await expect(api.storage.move()).rejects.toThrow(/only on the server/);
    await expect(api.rules.pickFile('jsonl')).rejects.toThrow(/only on the server/);
    await expect(api.openRouter.signIn()).rejects.toThrow(/only on the server/);
    expect(t.calls).toEqual([]);
  });
});

describe('the client app shell', () => {
  it('saves files, draws PDFs, shows the badge and opens panel windows on this device', async () => {
    setMediaRoot('/media/');
    const t = transport();
    const s = shell();
    const api = createRemoteRendererApi(t, s);
    await api.media.saveAttachment('a'.repeat(64), 'cat.png');
    expect(s.saveMedia).toHaveBeenCalledWith(expect.stringMatching(/^\/media\/attachment\//), 'cat.png');
    await api.media.savePdf({ html: '<p>', fileName: 'x.pdf', width: 800 });
    expect(s.savePdf).toHaveBeenCalledOnce();
    await api.desktop.setBadge({ mentions: 1, unread: 2 } as never);
    expect(s.setBadge).toHaveBeenCalledOnce();
    await api.openPanelWindow('alerts');
    expect(s.openPanelWindow).toHaveBeenCalledWith('alerts');
    expect(t.calls).toEqual([]);
    // Exports save through the app's dialogs, not the transport.
    expect(api.openExport).toBeUndefined();
  });

  it("shows the server's notices through the shell, and hands this window the shell's commands", () => {
    const t = transport();
    const s = shell();
    const api = createRemoteRendererApi(t, s);
    t.notice(notice);
    expect(s.notify).toHaveBeenCalledWith(notice);
    const got: AppEvent[] = [];
    const off = api.onEvent((e) => got.push(e));
    t.event({ type: 'status-changed' });
    s.command({ type: 'open-message', channelId: 'c', messageId: 'm' });
    off();
    s.command({ type: 'open-panel', panelId: 'alerts' });
    expect(got).toEqual([{ type: 'status-changed' }, { type: 'open-message', channelId: 'c', messageId: 'm' }]);
  });

  it('is used only when its contract matches the page', () => {
    expect(desktopShell({})).toBeNull();
    expect(desktopShell({ [DESKTOP_SHELL_GLOBAL]: { apiVersion: DESKTOP_SHELL_API_VERSION + 1 } })).toBeNull();
    const s = shell();
    expect(desktopShell({ [DESKTOP_SHELL_GLOBAL]: s })).toBe(s);
  });
});

describe('in a browser', () => {
  it("opens PDFs through the transport, as the phone does, and drops notices it can't show", async () => {
    const t = transport();
    const api = createRemoteRendererApi(t, null);
    expect(api.openExport).toBeTypeOf('function');
    await api.media.savePdf({ html: '<p>', fileName: 'x.pdf', width: 800 });
    expect(t.openExport).toHaveBeenCalledWith(expect.any(Promise), 'pdf');
    expect(() => t.notice(notice)).not.toThrow();
  });
});
