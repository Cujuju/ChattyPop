// One transport plugin carries phone calls/events/pushes; other plugins register routes. Disconnected traffic is dropped.
import type { AppEvent, CoreMethod } from '@shared/contract';
import type { DeliveredNotification } from '@shared/notifications';
import { PluginInactiveError, pluginCallResult, type PluginCallResult } from '@shared/pluginCall';
import { PHONE_DISCORD_METHODS, phoneAppEvent, phoneMayCallCore, phoneSetting, phoneSettingWrite, type PhoneCallGroup, type PhoneDiscordMethod } from '@shared/phone';
import type { CoreClient } from '../coreClient';
import type { MediaHandler } from '../media/mediaProtocol';

/** The Discord calls the phone may make, checked as the renderer's are (ipc/discord.ts). */
export type DiscordCalls = Record<PhoneDiscordMethod, (...args: unknown[]) => Promise<unknown>>;

/** What the connected transport receives: events the phone may get, and notifications for paired phones. */
export interface PhoneTransport {
  broadcast(e: AppEvent): void;
  notify(request: DeliveredNotification): void;
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

/** How the connected transport reaches the app: each call is stamped as the phone's, never as the caller claims. */
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
  media: MediaHandler;
  /** Whether a bundled plugin is on: a route answers only while its owner is. */
  active: (pluginId: string) => boolean;
}

const discordMethods = new Set<string>(PHONE_DISCORD_METHODS);
const routeKey = (pluginId: string, name: string): string => `${pluginId}\u0000${name}`;

/** Routes phone traffic between the app and at most one transport plugin. */
export class PhoneHub {
  private transport: { pluginId: string; to: PhoneTransport } | null = null;
  private readonly routes = new Map<string, PhoneRoute>();
  /** How phone traffic enters the app, stamped as the phone's: the connected transport's handle. */
  readonly gateway: PhoneGateway;

  constructor(private readonly d: PhoneHubDeps) {
    this.gateway = {
      call: (group, method, params) => this.call(group, method, params),
      route: (pluginId, name, request) => {
        const fn = this.routes.get(routeKey(pluginId, name));
        if (!fn) return Promise.reject(new PhoneRouteMissing(`No phone route ${pluginId}/${name}`));
        return pluginCallResult(() => {
          if (!d.active(pluginId)) throw new PluginInactiveError(pluginId);
          return fn(request);
        });
      },
      media: (url, range) => d.media(url, range),
    };
  }

  /**
   * Connects `pluginId` as the transport and returns its gateway; one at a time. The transport connects while it is on
   * (ctx.whileActive) and disconnects when it turns off. `disconnect` is idempotent.
   */
  connect(pluginId: string, to: PhoneTransport): { gateway: PhoneGateway; disconnect(): void } {
    if (this.transport) throw new Error(`${this.transport.pluginId} already carries the phone`);
    const entry = { pluginId, to };
    this.transport = entry;
    return {
      gateway: this.gateway,
      disconnect: () => {
        if (this.transport === entry) this.transport = null;
      },
    };
  }

  /** Registers a plugin's route; a later registration of the same name replaces it. */
  route(pluginId: string, name: string, fn: PhoneRoute): void {
    this.routes.set(routeKey(pluginId, name), fn);
  }

  /** Hands the transport an event as the phone may get it (phoneAppEvent): its types, audiences and settings. */
  broadcast(e: AppEvent): void {
    const shown = phoneAppEvent(e);
    if (shown) this.transport?.to.broadcast(shown);
  }

  /** Hands the transport a notification for paired phones. */
  notify(request: DeliveredNotification): void {
    this.transport?.to.notify(request);
  }

  private async call(group: PhoneCallGroup, method: string, params: unknown[]): Promise<unknown> {
    // A setting as the phone may read it (phoneSetting), the same cut as its change events.
    if (group === 'core' && method === 'getSetting') return phoneSetting(String(params[0]), await this.d.core.call('getSetting', String(params[0])));
    // Only PHONE_WRITABLE_SETTINGS, stored through their normalizers; any other write is refused below.
    if (group === 'core' && method === 'setSetting') {
      const write = phoneSettingWrite(String(params[0]), params[1]);
      if (write) return await this.d.core.call('setSetting', String(params[0]), write.value);
    }
    if (group === 'core' && phoneMayCallCore(method)) return await this.d.core.call(method as CoreMethod, ...(params as []));
    // Stamped 'phone' here: core answers only members whose audiences include the phone.
    if (group === 'plugins' && method === 'callCore' && typeof params[0] === 'string' && typeof params[1] === 'string' && Array.isArray(params[2]))
      return await this.d.core.call('pluginCall', 'phone', params[0], params[1], params[2] as unknown[]);
    if (group === 'discord' && discordMethods.has(method)) return await this.d.discord()[method as PhoneDiscordMethod](...params);
    throw new PhoneCallRefused(`Not available on the phone: ${String(group)}.${method}`);
  }
}
