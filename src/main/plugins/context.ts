// A bundled plugin's main context (docs/plugin-architecture.md §4–§5): Discord through the embedded session, dialogs,
// downloads, the phone, network and secrets, and its channels to core and to windows.
import type { Notifications } from '@shared/notifications';
import type { FileFilter } from 'electron';
import { stampedName, type ChannelsOf, type NoticeKinds, type PhoneRouteNames, type PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { audiencesOf, clientOver, membersOf, servedMember, type Client, type EventsOf, type MembersFor, type Served } from '@shared/pluginChannels';
import { SETTINGS_KEYS, builtInTheme, normalizeAppearanceSettings, type ThemeId } from '@shared/settings';
import { descriptorFetch, type NetworkSend, type PluginFetch } from '@core/plugins/net';
import { lifetimeFetch, type Lifetime } from '@core/plugins/lifetime';
import { PluginInactiveError } from '@shared/pluginCall';
import { pluginOn } from '@shared/plugins';
import type { LiveLabelProvider } from '../discord/labelProviders';
import type { MainCore } from '../coreClient';
import { errorMessage } from '@shared/errors';
import type { GuildEmojiIndex } from '../discord/guildEmojis';
import { guildEmojis, pluginDiscord, type GuildEmojis, type PluginDiscord, type PluginDiscordDeps } from './discordContext';
import type { AttachmentDownloader, AttachmentFetch } from '../media/attachmentDownloader';
import type { PhoneGateway, PhoneHub, PhoneRoute, PhoneTransport } from '../phone/hub';
import type { SyncService } from '../sync/syncService';
import type { TailnetServe } from '../tailnet';
import { listenLoopback, type LoopbackHandler, type LoopbackServer } from './loopback';
import { mainPreferences } from './preferences';
import type { MainPreferences } from '@shared/preferences';
import type { Pages } from './pages';
import { type Dispose, type PluginStates, type RunStart } from './states';
import type { HostNotifications } from '../notifications';

type MainEvents<D> = MembersFor<ChannelsOf<D>, 'events', 'main'>;
type WindowEvents<D> = MembersFor<ChannelsOf<D>, 'events', 'renderer' | 'phone'>;

/** A secret's name: its file is `<plugin id>-<name>` in the profile's secrets folder. */
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * One run of a switch-governed resource (whileActive), from its start until its plugin turns off or the app quits; work
 * it started that finishes later can then no longer act for the next run.
 */
export interface ResourceRun<D extends PluginDescriptor = PluginDescriptor> extends Lifetime {
  /** The plugin's secrets: writes and deletes throw PluginInactiveError once the run ended; reads stay open. */
  secrets: MainContext<D>['secrets'];
  /** net.fetch scoped to the run: it settles with PluginInactiveError when the run ends. */
  net: { fetch: PluginFetch };
  /** channels.emit while the run lasts; nothing after. */
  emit: MainContext<D>['channels']['emit'];
}
/** Starts a resource's run while its plugin is on; returns what stops it. */
export type ActiveResource<D extends PluginDescriptor = PluginDescriptor> = (run: ResourceRun<D>) => void | Dispose | Promise<void | Dispose>;

export interface MainContext<D extends PluginDescriptor = PluginDescriptor> {
  readonly plugin: D;
  /** Desktop and paired-phone notices; `kind` is one the descriptor declares (`notices`), stamped by the host. */
  notifications: Notifications<NoticeKinds<D>>;
  live: { labels: { provide(fn: LiveLabelProvider): void; changed(): void } };
  /** Discord through the embedded client's session (law 4: never Node fetch); writes only with descriptor `discord.write`. */
  discord: PluginDiscord<D>;
  /** Custom emojis the gateway reported, per server. */
  emojis: GuildEmojis;
  /** The archive's media folder; the plugin keeps files in a subfolder of its own. */
  mediaDir: string;
  attachments: {
    /** Downloads an attachment outside the store, through the Discord session; null, or why it failed. */
    fetchTo(r: AttachmentFetch): Promise<string | null>;
  };
  media: {
    /**
     * Downloads an image a message shows (archive.images: an embed's through Discord's media proxy and session, a
     * fetched X post's photo without it) at full size to `path`, in a format any decoder reads; null, or why it failed.
     */
    fetchImageTo(url: string, path: string): Promise<string | null>;
    /**
     * Downloads a video an embed shows (archive.parts: Discord's media proxy, through its session) to `path` as served,
     * capped at Discord's largest upload; null, or why it failed.
     */
    fetchVideoTo(url: string, path: string): Promise<string | null>;
  };
  /** Dialogs over the main window. */
  dialogs: {
    /** Empty when cancelled. */
    pickFiles(title: string, filters: FileFilter[]): Promise<string[]>;
    pickFolder(title: string): Promise<string | null>;
  };
  /** Brings these archived channels up to date (e.g. after an import). */
  sync(channelIds: string[]): void;
  /** Writes `<plugin id>-<event>` to the diagnostics log; never tokens or message content. */
  diag(event: string, detail?: Record<string, unknown>): void;
  /**
   * Runs `start` while the plugin is on, and the disposer it returns when it turns off (or the app quits), once its run
   * ended. Transitions run one at a time. For resources the switch must govern: a listening server, an external config.
   */
  whileActive(start: ActiveResource<D>): void;
  /** Strings encrypted by the OS keystore, readable only by this Windows account. `read` throws when undecryptable. */
  secrets: {
    read(name: string): string | null;
    write(name: string, value: string): void;
    delete(name: string): void;
  };
  net: {
    /** HTTPS to the descriptor's `network.hosts` and the owner's addresses (`network.ownerUrls`): core's ctx.net.fetch policy. */
    fetch: PluginFetch;
    /** A server on 127.0.0.1 (descriptor `network.loopback`); rejects with the listen error. A handler's escaped error is logged and answered 500. */
    listen(port: number, handler: LoopbackHandler): Promise<LoopbackServer>;
    /**
     * Tailscale Serve at the declared `network.tailnet.httpsPort`: `publish` proxies it to loopback `localPort` and
     * resolves with the HTTPS URL (rejects with TailnetError); `withdraw` removes it. The host removes it too whenever
     * the plugin is off or absent, so config left at quit stays only while the plugin stays on.
     */
    tailnet: { publish(localPort: number): Promise<string>; withdraw(): Promise<void> };
  };
  /** Its declared preferences (descriptor `preferences`), through core; onChange listens once the activation succeeds. */
  preferences: MainPreferences<D>;
  /** The owner's appearance choices a page served outside the app wears; the defaults when unreadable. A custom theme answers its built-in base. */
  appearance: { theme(): Promise<ThemeId> };
  /** The renderer's built pages (a plugin's own page and its public files) as replies; the dev server in `pnpm dev`. */
  pages: Pages;
  phone: {
    /** Carries the phone (descriptor `phone.transport`): receives its events and pushes, and gets the gateway. */
    connect(transport: PhoneTransport): { gateway: PhoneGateway; disconnect(): void };
    /** Serves a declared phone route; the transport routes a paired phone's request to it while this plugin is on. */
    route(name: PhoneRouteNames<D>, fn: PhoneRoute): void;
  };
  channels: {
    /** Core's calls whose audiences include main. */
    core: Client<MembersFor<ChannelsOf<D>, 'core', 'main'>>;
    /** Serves every main call the contract declares (windows call them; check their arguments). */
    serve(impl: Served<ChannelsOf<D>, 'main'>): void;
    /** Core's events for main. A throw or rejection is logged. */
    on<K extends keyof MainEvents<D> & string>(name: K, fn: (payload: EventsOf<ChannelsOf<D>>[K]) => unknown): void;
    /** Emits an event to its declared window and phone audiences while the plugin is on. */
    emit<K extends keyof WindowEvents<D> & string>(name: K, payload: EventsOf<ChannelsOf<D>>[K]): void;
  };
}

/** A plugin's main side (its folder's main/index.ts). */
export interface MainPlugin<D extends PluginDescriptor = PluginDescriptor> {
  plugin: D;
  activate(ctx: MainContext<D>): void;
}

/** The profile's secret files (`<plugin id>-<name>`), encrypted by the OS keystore. */
export interface SecretFiles {
  read(file: string): string | null;
  write(file: string, value: string): void;
  delete(file: string): void;
}

export interface MainPluginDeps {
  notifications: HostNotifications;
  liveLabels: { provide(id: string, fn: LiveLabelProvider): void; changed(): void };
  /** File and folder pickers over the main window. */
  dialogs: MainContext['dialogs'];
  secrets: SecretFiles;
  /** Writes an event to the diagnostics log. */
  diag(event: string, detail?: Record<string, unknown>): void;
  core: MainCore;
  discord: PluginDiscordDeps;
  emojiIndex: Pick<GuildEmojiIndex, 'all' | 'forGuild'>;
  mediaDir: string;
  sync: Pick<SyncService, 'enqueue'>;
  downloader: Pick<AttachmentDownloader, 'fetchTo'>;
  media: MainContext['media'];
  states: PluginStates;
  phone: Pick<PhoneHub, 'connect' | 'route'>;
  pages: Pages;
  /** Plugins' Tailscale Serve config, recorded by the host. */
  tailnet: Pick<TailnetServe, 'publish' | 'withdraw' | 'reconcile'>;
  /** Sends a plugin event to the windows and the phone its audiences name. */
  publish(e: AppEvent): void;
  /** The network ctx.net.fetch sends through once its policy allows a request; the global fetch when unset. */
  send?: NetworkSend;
}

/**
 * Where a plugin's main side registers: its served calls, its event listeners, its switch-governed resources, and
 * `stage` for any other registration (label providers, phone routes). All are held until the activation succeeds.
 */
export interface MainRegistrations {
  serve(name: string, fn: (...args: unknown[]) => unknown): void;
  on(name: string, fn: (payload: unknown) => unknown): void;
  whileActive(start: RunStart): void;
  stage(apply: () => void): void;
}

/** `ctx`'s effects scoped to the run `life`. */
export function resourceRun<D extends PluginDescriptor>(ctx: MainContext<D>, life: Lifetime): ResourceRun<D> {
  const pluginId = ctx.plugin.manifest.id;
  const writing = <A extends unknown[]>(write: (...args: A) => void) => (...args: A): void => {
    if (!life.live()) throw new PluginInactiveError(pluginId);
    write(...args);
  };
  return {
    signal: life.signal,
    live: life.live,
    fence: life.fence,
    secrets: { read: (name) => ctx.secrets.read(name), write: writing(ctx.secrets.write), delete: writing(ctx.secrets.delete) },
    net: { fetch: lifetimeFetch(ctx.net.fetch, life) },
    emit: (name, payload) => void (life.live() && ctx.channels.emit(name, payload)),
  };
}

/** Builds a plugin's main context. */
export function createMainContext<D extends PluginDescriptor>(plugin: D, d: MainPluginDeps, reg: MainRegistrations): MainContext<D> {
  const id = plugin.manifest.id;
  const secretFile = (name: string): string => {
    if (!SECRET_NAME.test(name)) throw new Error(`${id} secret ${name}: must match ${SECRET_NAME}`);
    return `${id}-${name}`;
  };
  // Emoji reads go through it too: paced, as all a plugin's reads are.
  const discord = pluginDiscord(plugin, d.discord);
  const ctx: MainContext<D> = {
    plugin,
    // Checked before each transport sends: a plugin turned off while settings are read sends nothing more.
    notifications: {
      show: async ({ kind, ...request }) => {
        if (kind !== undefined && !plugin.notices?.some((n) => n.kind === kind)) throw new Error(`${id} sends notice kind ${kind} but declares none`);
        await d.notifications.show({ ...request, ...(kind !== undefined && { kind: stampedName(id, kind) }) }, async () => pluginOn(await d.core.call('plugins'), id));
      },
    },
    live: { labels: { provide: (fn) => reg.stage(() => d.liveLabels.provide(id, fn)), changed: () => d.liveLabels.changed() } },
    discord,
    emojis: guildEmojis(d.emojiIndex, discord),
    mediaDir: d.mediaDir,
    attachments: { fetchTo: (r) => d.downloader.fetchTo(r) },
    media: { fetchImageTo: (url, path) => d.media.fetchImageTo(url, path), fetchVideoTo: (url, path) => d.media.fetchVideoTo(url, path) },
    dialogs: { pickFiles: (title, filters) => d.dialogs.pickFiles(title, filters), pickFolder: (title) => d.dialogs.pickFolder(title) },
    sync: (channelIds) => channelIds.forEach((c) => d.sync.enqueue(c)),
    diag: (event, detail) => d.diag(`${id}-${event}`, detail),
    whileActive: (start) => reg.whileActive((life) => start(resourceRun(ctx, life))),
    secrets: {
      read: (name) => d.secrets.read(secretFile(name)),
      write: (name, value) => d.secrets.write(secretFile(name), value),
      delete: (name) => d.secrets.delete(secretFile(name)),
    },
    net: {
      fetch: descriptorFetch(plugin, (key) => d.core.call('getSetting', key), d.send),
      listen: (port, handler) => {
        if (!plugin.network?.loopback) return Promise.reject(new Error(`${id} does not declare network.loopback`));
        return listenLoopback(port, handler, (err) => d.diag(`${id}-request-failed`, { message: errorMessage(err) }));
      },
      tailnet: {
        publish: (localPort) => {
          const port = plugin.network?.tailnet?.httpsPort;
          return port === undefined ? Promise.reject(new Error(`${id} does not declare network.tailnet`)) : d.tailnet.publish(id, port, localPort);
        },
        withdraw: () => {
          const port = plugin.network?.tailnet?.httpsPort;
          return port === undefined ? Promise.resolve() : d.tailnet.withdraw(id, port);
        },
      },
    },
    preferences: mainPreferences(plugin, d.core, reg.stage),
    appearance: { theme: async () => builtInTheme(normalizeAppearanceSettings(await d.core.call('getSetting', SETTINGS_KEYS.appearance).catch(() => null))) },
    pages: d.pages,
    phone: {
      connect: (transport) => {
        if (!plugin.phone?.transport) throw new Error(`${id} does not declare phone.transport`);
        return d.phone.connect(id, transport);
      },
      route: (name, fn) => {
        if (!plugin.phone?.routes?.includes(name)) throw new Error(`${id} does not declare phone route ${name}`);
        reg.stage(() => d.phone.route(id, name, fn));
      },
    },
    channels: {
      // Stamped 'main' here: core answers only members whose audiences include main.
      core: clientOver((name, args) => d.core.call('pluginCall', 'main', id, name, args)),
      serve: (impl) => {
        for (const name of membersOf(plugin.channels, 'main')) {
          const fn = servedMember(impl, name);
          if (!fn) throw new Error(`${id} declares main call ${name} but serves none`);
          reg.serve(name, fn);
        }
      },
      // Notices a handler shows are checked against privacy mode as its event found it.
      on: (name, fn) => reg.on(name, (payload) => d.notifications.handling(() => fn(payload as never))),
      emit: (name, payload) => {
        const audiences = audiencesOf(plugin.channels, 'events', name);
        if (!audiences.includes('renderer') && !audiences.includes('phone')) throw new Error(`${id} event ${name} has no window or phone audience`);
        if (d.states.active(id)) d.publish({ type: 'plugin-event', pluginId: id, name, payload });
      },
    },
  };
  return ctx;
}
