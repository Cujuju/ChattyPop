// Runs main plugins through real host routing, notifications, states, phone and labels atop core harnesses. External session/dialog/keystore/network services are stand-ins.
import { join } from 'node:path';
import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { notificationRequest, type DeliveredNotification } from '@shared/notifications';
import { noticesFor, privacyScopedIn } from '@shared/notices';
import { phoneAppEvent } from '@shared/phone';
import { audiencesOf, clientOver } from '@shared/pluginChannels';
import { normalizeNotificationSettings, SETTINGS_KEYS } from '@shared/settings';
import type { DiscordClient } from '@main/discord/client';
import { LiveLabelProviders } from '@main/discord/labelProviders';
import { PhoneHub } from '@main/phone/hub';
import { notificationService } from '@main/notifications';
import type { MainCore } from '@main/coreClient';
import type { MainPluginDeps } from '@main/plugins/context';
import { ActionSpacer } from '@main/plugins/discordContext';
import { rendererPages } from '@main/plugins/pages';
import { startMainSides } from '@main/plugins/sides';
import { PluginStates } from '@main/plugins/states';
import { TailnetError } from '@main/tailnet';
import { corePort, mainLink, mainPort } from '../../shared/testing/ports';
import type { Diagnostic, TestMainPlugin, TestMainPluginFn } from './types';

const refuse = (what: string) => (): Promise<never> => Promise.reject(new Error(`This test gives the plugin no ${what}.`));
/** Discord as a test without a session stand-in has it: every request rejects. */
const NO_DISCORD: DiscordClient = {
  get: refuse('Discord session'),
  post: refuse('Discord session'),
  postOnce: refuse('Discord session'),
  put: refuse('Discord session'),
  putJson: refuse('Discord session'),
  patch: refuse('Discord session'),
  delete: refuse('Discord session'),
  upload: refuse('Discord session'),
};

/** The phone's Discord calls, which a test's phone gateway has none of. */
const NO_PHONE_DISCORD = (): never => {
  throw new Error('This test gives the phone no Discord session.');
};

export const testMainPlugin: TestMainPluginFn = async (main, core, o = {}) => {
  const side = corePort(core.link);
  const id = main.plugin.manifest.id;
  const diagnostics: Diagnostic[] = [];
  const diag = (event: string, detail: Record<string, unknown> = {}): void => void diagnostics.push({ event, detail });
  const coreClient: MainCore = { call: side.call as MainCore['call'], on: (_event, fn) => side.on(fn) };
  const states = new PluginStates(() => coreClient.call('plugins'), (err) => diag('plugin-states-failed', { message: errorMessage(err) }));
  const delivered = { desktop: [] as DeliveredNotification[], phone: [] as DeliveredNotification[] };
  const hub = new PhoneHub({ core: coreClient, discord: NO_PHONE_DISCORD, main: refuse('main calls'), media: refuse('media store'), active: (p) => states.active(p) });
  const notifications = notificationService({
    settings: async () => ({ notifications: normalizeNotificationSettings(await coreClient.call('getSetting', SETTINGS_KEYS.notifications)) }),
    desktop: (n) => void delivered.desktop.push(n),
    push: (n) => {
      delivered.phone.push(n);
      hub.notify(n);
    },
    privacyScoped: (kind) => privacyScopedIn(side.installed, kind),
    muted: (channelIds) => coreClient.call('allMuted', channelIds),
  });
  const labels = new LiveLabelProviders((p) => states.active(p), (p, err) => diag('plugin-labels-failed', { id: p, message: errorMessage(err) }));
  const windows = new Set<(e: AppEvent) => void>();
  const phones = new Set<(e: AppEvent) => void>();
  const secrets = new Map(Object.entries(o.secrets ?? {}).map(([name, value]) => [`${id}-${name}`, value]));
  const synced: string[] = [];
  const emojis = o.emojis ?? {};
  const installed = new Map(side.installed.map((p) => [p.manifest.id, p]));
  const reaches = (e: AppEvent, audience: 'renderer' | 'phone'): boolean =>
    e.type !== 'plugin-event' || audiencesOf(installed.get(e.pluginId)?.channels, 'events', e.name).includes(audience);
  /** What the hub hands its transport (phoneAppEvent), plugin events by the installed descriptors' audiences. */
  const toPhone = (e: AppEvent): AppEvent | null => (e.type === 'plugin-event' ? (reaches(e, 'phone') ? e : null) : phoneAppEvent(e));
  const deps: MainPluginDeps = {
    notifications,
    liveLabels: { provide: (p, fn) => labels.provide(p, fn), changed: () => undefined },
    dialogs: { pickFiles: o.dialogs?.pickFiles ?? (async () => []), pickFolder: o.dialogs?.pickFolder ?? (async () => null) },
    secrets: { read: (file) => secrets.get(file) ?? null, write: (file, value) => void secrets.set(file, value), delete: (file) => void secrets.delete(file) },
    diag,
    core: coreClient,
    // Shares both Discord lanes without automatic-post waits. Posting starts unlocked; separate posting-lock tests cover the unlocking contract.
    discord: { paced: o.discord ?? NO_DISCORD, prompt: o.discord ?? NO_DISCORD, humanPause: async () => undefined, posting: { unlocked: async () => true }, spacer: new ActionSpacer(async () => 0) },
    emojiIndex: { all: () => Object.values(emojis).flat(), forGuild: async (_api, guildId) => [...(emojis[guildId] ?? [])] },
    mediaDir: side.mediaDir,
    sync: { enqueue: (channelId) => void synced.push(channelId) },
    downloader: { fetchTo: o.attachments ?? refuse('attachment downloads') },
    media: { fetchImageTo: o.images ?? refuse('image downloads'), fetchVideoTo: o.videos ?? refuse('video downloads') },
    pdf: o.pdf ?? refuse('PDF drawing'),
    states,
    phone: hub,
    pages: rendererPages(join(side.profileDir, 'renderer'), null),
    tailnet: { publish: () => Promise.reject(new TailnetError('This test has no tailnet.')), withdraw: async () => undefined, reconcile: async () => undefined },
    // Routes core/main plugin events like coreEvents.publish: audience-filtered windows receive separate copies; the phone hub applies its own filtering.
    publish: (e) => {
      if (reaches(e, 'renderer')) windows.forEach((fn) => fn(structuredClone(e)));
      hub.broadcast(e);
      const shown = toPhone(e);
      if (shown) phones.forEach((fn) => fn(shown));
    },
    send: o.network ?? refuse('network'),
  };
  await states.refresh();
  const started = startMainSides([main, ...(o.with ?? [])], deps, side.installed);
  side.on((e) => {
    if (e.type === 'plugins-changed') void states.refresh();
    if (e.type === 'privacy-changed') notifications.privacyChanged();
    for (const notice of noticesFor(e)) void notifications.show(notificationRequest(notice)).catch((err: unknown) => diag('notification-failed', { message: errorMessage(err) }));
    started.deliver(e);
    deps.publish(e);
  });
  side.afterSwitch.push(async () => {
    await states.refresh();
    await started.sync();
  });
  await started.sync();
  // A window's main call crosses IPC: structured clones both ways.
  const link = mainLink({ callMain: (pluginId, name, args) => started.callMain(pluginId, name, structuredClone(args)).then(structuredClone), on: (fn) => (windows.add(fn), () => windows.delete(fn)), onPhone: (fn) => (phones.add(fn), () => phones.delete(fn)) });
  const t: TestMainPlugin<typeof main.plugin> = {
    plugin: main.plugin,
    client: () => clientOver((name, args) => mainPort(link).callMain(id, name, args)),
    notifications: () => ({ desktop: [...delivered.desktop], phone: [...delivered.phone] }),
    diagnostics: () => [...diagnostics],
    secrets: () => Object.fromEntries([...secrets].flatMap(([file, value]) => (file.startsWith(`${id}-`) ? [[file.slice(id.length + 1), value]] : []))),
    synced: () => [...synced],
    labels: (channelId) => labels.read(channelId),
    route: (name, request) => hub.gateway.route(id, name, request),
    link,
    stop: () => started.stop(),
  };
  return t;
};
