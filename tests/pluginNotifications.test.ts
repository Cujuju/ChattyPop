// Main probe notifications exercise policy, lifecycle and click targets through the host transports: the desktop
// toast, and a push sink standing in for a phone transport plugin.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineMainPlugin, type MainContext, type MainPlugin, type NotificationRequest } from '@plugin-sdk/main';
import { createMainContext, type MainPluginDeps } from '../src/main/plugins/context';
import { notificationService } from '../src/main/notifications';
import { notifyDesktop } from '../src/main/desktopNotifications';
import { privacyScopedIn } from '@shared/notices';
import type { DeliveredNotification } from '@shared/notifications';

const state = vi.hoisted(() => ({
  supported: true,
  toasts: [] as { options: { title: string; body: string }; click(): void }[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    dialog: {},
    Notification: class extends EventEmitter {
      static isSupported = () => state.supported;
      constructor(readonly options: { title: string; body: string }) {
        super();
      }
      show(): void {
        state.toasts.push(this);
        this.emit('show');
      }
      click(): void { this.emit('click'); }
    },
  };
});
vi.mock('../src/main/diagnostics', () => ({ diag: vi.fn() }));
vi.mock('../src/main/windowState', () => ({
  raiseWindow: (win: BrowserWindow) => {
    if (win.isDestroyed()) return false;
    win.show();
    win.focus();
    return true;
  },
}));
const plugin = definePlugin({
  manifest: {
    id: 'probe',
    name: 'Probe',
    version: '1',
    description: '',
  },
  notices: [{ kind: 'alert', privacyScoped: true }],
});
/** A main side whose core events each show a privacy-scoped notice, desktop too only when core says it notifies (as automatic summaries do). */
const digest = definePlugin({
  manifest: { id: 'digest', name: 'Digest', version: '1', description: '' },
  notices: [{ kind: 'summary', privacyScoped: true }],
  channels: defineChannels<{ core: { notifyAuto(): boolean }; events: { added: string; failed: string } }>()({
    core: { notifyAuto: ['main'] },
    events: { added: ['main'], failed: ['main'] },
  }),
});
const digestMain = defineMainPlugin(digest, (ctx) => {
  const send = async (title: string): Promise<void> => {
    const desktop = await ctx.channels.core.notifyAuto();
    await ctx.notifications.show({ kind: 'summary', title, body: '', target: null, ...(!desktop && { desktop: false as const }) });
  };
  ctx.channels.on('added', send);
  ctx.channels.on('failed', send);
});
const request: NotificationRequest<'alert'> = {
  title: 'Probe title',
  body: 'Probe body',
  target: {
    kind: 'message',
    channelId: 'channel',
    messageId: 'message',
  },
};

function harness() {
  let enabled = true;
  let desktop = true;
  let notifyAuto = true;
  let duringSettings = (): void => undefined;
  let duringNotifyAuto = (): void => undefined;
  /** What the phone transport was handed, in order. */
  const pushed: DeliveredNotification[] = [];
  const toMain = vi.fn();
  const win = {
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;
  const notifications = notificationService({
    settings: async () => {
      duringSettings();
      return { notifications: { desktop, muted: { guildIds: [], channelIds: [] } } };
    },
    desktop: (n) => notifyDesktop(win, n, toMain),
    push: (n) => void pushed.push(n),
    privacyScoped: (kind) => privacyScopedIn([plugin, digest], kind),
    muted: async () => false,
  });
  let ctx!: MainContext<typeof plugin>;
  const probe: MainPlugin<typeof plugin> = {
    plugin,
    activate: (context) => { ctx = context; },
  };
  const deps = {
    notifications,
    core: {
      call: async (method: string) => method === 'pluginCall' ? (duringNotifyAuto(), { status: 'ok', value: notifyAuto }) : enabled
        ? ['probe', 'digest'].map((id) => ({ id, bundled: true, status: 'active' }))
        : [],
    },
  } as unknown as MainPluginDeps;
  probe.activate(createMainContext(plugin, deps, {
    serve: () => undefined,
    on: () => undefined,
    whileActive: () => undefined, stage: (apply: () => void) => apply(),
  }));
  const digestEvents = new Map<string, (payload: unknown) => unknown>();
  digestMain.activate(createMainContext(digest, deps, {
    serve: () => undefined,
    whileActive: () => undefined, stage: (apply: () => void) => apply(),
    on: (name, listener) => { digestEvents.set(name, listener); },
  }));
  return {
    show: (n: NotificationRequest<'alert'> = request) => ctx.notifications.show(n),
    off: () => { enabled = false; },
    /** Runs while delivery reads the settings (between the phone push and the desktop toast). */
    duringSettings: (fn: () => void) => { duringSettings = fn; },
    /** Runs while Digest asks core whether its notices reach the desktop. */
    duringNotifyAuto: (fn: () => void) => { duringNotifyAuto = fn; },
    /** Core reported a privacy change (main's privacy-changed event). */
    privacyChanged: () => notifications.privacyChanged(),
    digestAdded: () => digestEvents.get('added')!('Launch moved to Friday'),
    desktopOff: () => { desktop = false; },
    quietDigest: () => { notifyAuto = false; },
    digestFailed: () => digestEvents.get('failed')!('provider down'),
    pushed,
    toMain,
    win,
  };
}

beforeEach(() => {
  state.toasts.length = 0;
  state.supported = true;
});

describe('main notification probe', () => {
  it('sends nothing to any device once its plugin turned off while settings were read', async () => {
    const h = harness();
    h.duringSettings(h.off);
    await h.show();
    expect(h.pushed).toHaveLength(0);
    expect(state.toasts).toHaveLength(0);
  });

  it('shows no alert made before privacy mode changed while settings were read; other kinds still show', async () => {
    const h = harness();
    h.duringSettings(h.privacyChanged);
    await h.show({ ...request, kind: 'alert' });
    // Settings are read before any device gets it (muted places), so neither does.
    expect(h.pushed).toHaveLength(0);
    expect(state.toasts).toHaveLength(0);
    await h.show();
    expect(state.toasts).toHaveLength(1);
  });

  it("shows no notice an event handler made before privacy mode changed while it awaited core", async () => {
    const h = harness();
    h.duringNotifyAuto(h.privacyChanged);
    await h.digestAdded();
    expect(h.pushed).toHaveLength(0);
    expect(state.toasts).toHaveLength(0);
    h.duringNotifyAuto(() => undefined);
    await h.digestAdded();
    expect(state.toasts).toHaveLength(1);
  });

  it('narrows desktop delivery per request while phone pushes and the global desktop switch remain independent', async () => {
    const h = harness();
    await h.show({ ...request, desktop: false });
    expect(state.toasts).toHaveLength(0);
    expect(h.pushed).toHaveLength(1);
    await h.show();
    expect(state.toasts).toHaveLength(1);
    expect(h.pushed).toHaveLength(2);
    h.desktopOff();
    await h.show({ ...request });
    expect(state.toasts).toHaveLength(1);
    expect(h.pushed).toHaveLength(3);
  });

  it('delivers once to desktop and the phone transport with the same text and message click target', async () => {
    const h = harness();
    await h.show();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.options).toEqual({ title: request.title, body: request.body });
    expect(h.pushed).toEqual([{ ...request, kind: 'plugin' }]);
    state.toasts[0]!.click();
    expect(h.win.show).toHaveBeenCalledOnce();
    expect(h.toMain).toHaveBeenCalledWith({ type: 'open-message', channelId: 'channel', messageId: 'message' });
  });

  it('pushes stamped kinds whatever the desktop and core-side settings, and blocks a held context after disable', async () => {
    const h = harness();
    h.desktopOff();
    await h.show();
    expect(state.toasts).toHaveLength(0);
    await h.show({ ...request, kind: 'alert' });
    expect(h.pushed.map((n) => n.kind)).toEqual(['plugin', 'probe.alert']);
    h.off();
    await h.show({ ...request, kind: 'alert' });
    expect(h.pushed).toHaveLength(2);
    const quiet = harness();
    quiet.quietDigest();
    await quiet.digestFailed();
    expect(state.toasts).toHaveLength(0);
    expect(quiet.pushed.map((n) => n.kind)).toEqual(['digest.summary']);
    await quiet.show();
    expect(state.toasts).toHaveLength(1);
  });

  it('supports panel and null targets, and still pushes when desktop notifications are unsupported', async () => {
    const h = harness();
    const target = { kind: 'panel', panelId: 'probe' } as const;
    await h.show({ ...request, target });
    state.toasts[0]!.click();
    expect(h.toMain).toHaveBeenCalledWith({ type: 'open-panel', panelId: 'probe' });
    expect(h.pushed[0]).toMatchObject({ target });
    h.toMain.mockClear();
    await h.show({ ...request, target: null });
    state.toasts[1]!.click();
    expect(h.toMain).not.toHaveBeenCalled();
    state.supported = false;
    await h.show();
    expect(state.toasts).toHaveLength(2);
    expect(h.pushed).toHaveLength(3);
  });
});
