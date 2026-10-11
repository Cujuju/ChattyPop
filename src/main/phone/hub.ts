// One transport plugin carries phone calls/events/pushes and remote desktops' calls and events; other plugins register
// routes. Disconnected traffic is dropped.
import { MAIN_INVOKE, type AppEvent, type CoreMethod } from '@shared/contract';
import type { DeliveredNotification } from '@shared/notifications';
import { PluginInactiveError, pluginCallResult, type PluginCallResult } from '@shared/pluginCall';
import { PHONE_DISCORD_METHODS, phoneAppEvent, phoneMayCallCore, phoneMayCallMain, phoneMayWriteSetting, phoneSetting, type PhoneCallGroup, type PhoneDiscordMethod } from '@shared/phone';
import { remoteAppEvent, remoteMayCallCore, remoteMayCallDiscord, remoteMayCallMain } from '@shared/remote';
import type { CoreClient } from '../coreClient';
import type { MediaHandler } from '../media/mediaProtocol';

/** The Discord calls the phone may make, checked as the renderer's are (ipc/discord.ts). */
export type DiscordCalls = Record<PhoneDiscordMethod, (...args: unknown[]) => Promise<unknown>>;

/** A pairing code the transport offers, for the server's tray and console. */
export interface PairingPrompt {
  code: string;
  /** Opens the pairing page with the code filled in; null while the transport isn't published. */
  url: string | null;
  expiresAt: number;
}

/** What the connected transport receives: events the phone and remote desktops may get, and notifications. */
export interface PhoneTransport {
  broadcast(e: AppEvent): void;
  notify(request: DeliveredNotification): void;
  /** Events for remote desktops (remoteAppEvent applied). Absent: the transport serves phones only. */
  broadcastDesktop?(e: AppEvent): void;
  /** A new pairing code, replacing any earlier one. Absent: the transport pairs only from its own Settings. */
  startPairing?(): PairingPrompt | Promise<PairingPrompt>;
}

/** A request a phone sent to a plugin's route; `device` names the paired phone. */
export interface PhoneRouteRequest {
  method: string;
  query: Readonly<Record<string, string>>;
  /** The parsed JSON body; null when none was sent. */
  body: unknown;
  device: string;
}
/** A plugin's route: its JSON-serializable result is the reply. */
export type PhoneRoute = (request: PhoneRouteRequest) => unknown;

/** A call the phone may not make; the transport answers 403. */
export class PhoneCallRefused extends Error {}
/** No plugin in this build registered that route; the transport answers 404. */
export class PhoneRouteMissing extends Error {}

/** How the connected transport reaches the app: each call is stamped as the phone's (or a remote desktop's), never as the caller claims. */
export interface PhoneGateway {
  /** A core method (PHONE_CORE_METHODS), a plugin core call (`plugins.callCore`, audience phone) or a Discord method. */
  call(group: PhoneCallGroup, method: string, params: unknown[]): Promise<unknown>;
  /** A plugin's route; an inactive owner answers `{ status: 'inactive' }`, as plugin calls do. */
  route(pluginId: string, name: string, request: PhoneRouteRequest): Promise<PluginCallResult>;
  /** An archived media file (cp-media:// route), honouring a Range header. */
  media(url: URL, range: string | null): Promise<Response>;
}

export interface PhoneHubDeps {
  core: Pick<CoreClient, 'call'>;
  /** Available once the Discord handlers exist; a transport connects only after that. */
  discord: () => DiscordCalls;
  /** Main's window calls by channel (ipc/mainCalls.ts). */
  main: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  media: MediaHandler;
  /** Whether a bundled plugin is on: a route answers only while its owner is. */
  active: (pluginId: string) => boolean;
}

/** What `connect` hands the transport: the phone's gateway, remote desktops' gateway, and the way out. */
export interface PhoneLink {
  gateway: PhoneGateway;
  /** Calls as a window makes them (renderer audience, REMOTE_* lists): for paired remote desktops only. */
  desktopGateway: PhoneGateway;
  disconnect(): void;
}

const discordMethods = new Set<string>(PHONE_DISCORD_METHODS);
const routeKey = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** Routes phone and remote desktop traffic between the app and at most one transport plugin. */
export class PhoneHub {
  private transport: { pluginId: string; to: PhoneTransport } | null = null;
  private readonly routes = new Map<string, PhoneRoute>();
  /** How phone traffic enters the app, stamped as the phone's: the connected transport's handle. */
  readonly gateway: PhoneGateway;
  /** How remote desktops' traffic enters the app, stamped as a window's. */
  readonly desktopGateway: PhoneGateway;

  constructor(private readonly d: PhoneHubDeps) {
    const route: PhoneGateway['route'] = (pluginId, name, request) => {
      const fn = this.routes.get(routeKey(pluginId, name));
      if (!fn) return Promise.reject(new PhoneRouteMissing(`No phone route ${pluginId}/${name}`));
      return pluginCallResult(() => {
        if (!d.active(pluginId)) throw new PluginInactiveError(pluginId);
        return fn(request);
      });
    };
    const media: PhoneGateway['media'] = (url, range) => d.media(url, range);
    this.gateway = { call: (group, method, params) => this.call(group, method, params), route, media };
    this.desktopGateway = { call: (group, method, params) => this.desktopCall(group, method, params), route, media };
  }

  /**
   * Connects `pluginId` as the transport and returns its gateway; one at a time. The transport connects while it is on
   * (ctx.whileActive) and disconnects when it turns off. `disconnect` is idempotent.
   */
  connect(pluginId: string, to: PhoneTransport): PhoneLink {
    if (this.transport) throw new Error(`${this.transport.pluginId} already carries the phone`);
    const entry = { pluginId, to };
    this.transport = entry;
    return {
      gateway: this.gateway,
      desktopGateway: this.desktopGateway,
      disconnect: () => {
        if (this.transport === entry) this.transport = null;
      },
    };
  }

  /** Registers a plugin's route; a later registration of the same name replaces it. */
  route(pluginId: string, name: string, fn: PhoneRoute): void {
    this.routes.set(routeKey(pluginId, name), fn);
  }

  /** Hands the transport an event as the phone may get it (phoneAppEvent) and as remote desktops may (remoteAppEvent). */
  broadcast(e: AppEvent): void {
    const shown = phoneAppEvent(e);
    if (shown) this.transport?.to.broadcast(shown);
    const desktop = remoteAppEvent(e);
    if (desktop) this.transport?.to.broadcastDesktop?.(desktop);
  }

  /** Hands the transport a notification for paired devices. */
  notify(request: DeliveredNotification): void {
    this.transport?.to.notify(request);
  }

  /** A pairing code from the connected transport; null when none is connected or it pairs only from its own Settings. */
  async startPairing(): Promise<PairingPrompt | null> {
    const to = this.transport?.to;
    return to?.startPairing ? await to.startPairing() : null;
  }

  private async call(group: PhoneCallGroup, method: string, params: unknown[]): Promise<unknown> {
    // A setting as the phone may read it (phoneSetting), the same cut as its change events.
    if (group === 'core' && method === 'getSetting') return phoneSetting(String(params[0]), await this.d.core.call('getSetting', String(params[0])));
    // Settings the phone shares as config (phoneMayWriteSetting); any other write is refused below.
    if (group === 'core' && method === 'setSetting' && phoneMayWriteSetting(String(params[0]))) return await this.d.core.call('setSetting', String(params[0]), params[1]);
    if (group === 'core' && phoneMayCallCore(method)) return await this.d.core.call(method as CoreMethod, ...(params as []));
    // Stamped 'phone' here: core answers only members whose audiences include the phone.
    if (group === 'plugins' && method === 'callCore' && typeof params[0] === 'string' && typeof params[1] === 'string' && Array.isArray(params[2]))
      return await this.d.core.call('pluginCall', 'phone', params[0], params[1], params[2] as unknown[]);
    if (group === 'main' && phoneMayCallMain(method)) return await this.d.main(method, params);
    if (group === 'discord' && discordMethods.has(method)) return await this.d.discord()[method as PhoneDiscordMethod](...params);
    throw new PhoneCallRefused(`Not available on the phone: ${String(group)}.${method}`);
  }

  /** A remote desktop's call, as the window would make it; what needs the server's screen or disk is refused. */
  private async desktopCall(group: PhoneCallGroup, method: string, params: unknown[]): Promise<unknown> {
    if (group === 'core' && remoteMayCallCore(method)) return await this.d.core.call(method as CoreMethod, ...(params as []));
    // Stamped 'renderer' by main's own plugin calls (plugins/bundled.ts), which check them as a window's.
    if (group === 'plugins' && (method === 'callCore' || method === 'callMain')) return await this.d.main(MAIN_INVOKE.plugins[method], params);
    if (group === 'discord' && remoteMayCallDiscord(method)) {
      // The calls the phone shares have one gated set (ipc/discord.ts); the rest are main's by channel.
      if (discordMethods.has(method)) return await this.d.discord()[method as PhoneDiscordMethod](...params);
      return await this.d.main(MAIN_INVOKE.discord[method], params);
    }
    if (group === 'main' && remoteMayCallMain(method)) return await this.d.main(method, params);
    throw new PhoneCallRefused(`Not available on a remote desktop: ${String(group)}.${method}`);
  }
}
