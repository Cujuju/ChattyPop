// The main testing harness's public types (docs/plugin-architecture.md §15): SDK types only, so a plugin's tests never
// see a host internal (tests/pluginTesting.test.ts checks the import graph).
export type { MainLink } from '@plugin-sdk/shared/testing';
import type { CoreLink, MainLink } from '@plugin-sdk/shared/testing';
import type { AttachmentFetch, DeliveredNotification, DiscordClient, MainContext, MainPlugin, PhoneRouteRequest } from '@plugin-sdk/main';
import type { ChannelsOf, Client, GuildEmoji, MembersFor, PhoneRouteNames, PluginDescriptor } from '@plugin-sdk/shared';

/** How a test starts a plugin's main side over its core (a TestPlugin from @plugin-sdk/core/testing). */
export interface MainTestOptions {
  /** Other installed plugins' main sides, started after it. */
  with?: readonly MainPlugin[];
  /** The owner's answers to the plugin's file and folder pickers; unset, each is cancelled. */
  dialogs?: Partial<MainContext['dialogs']>;
  /** Discord through the embedded session; unset, every request rejects. */
  discord?: DiscordClient;
  /** The network behind ctx.net.fetch, each hop after the descriptor's policy allowed it; unset, requests reject. */
  network?: (url: URL, init: RequestInit) => Promise<Response>;
  /** Custom emojis the gateway reported, by server id. */
  emojis?: Readonly<Record<string, readonly GuildEmoji[]>>;
  /** Downloads for ctx.attachments.fetchTo; unset, each fails. */
  attachments?: (r: AttachmentFetch) => Promise<string | null>;
  /** Downloads for ctx.media.fetchImageTo; unset, each fails. */
  images?: (url: string, path: string) => Promise<string | null>;
  /** Downloads for ctx.media.fetchVideoTo; unset, each fails. */
  videos?: (url: string, path: string) => Promise<string | null>;
  /** The plugin's stored secrets, by name. */
  secrets?: Readonly<Record<string, string>>;
}

/** A diagnostics log line: its event and detail. */
export interface Diagnostic {
  event: string;
  detail: Record<string, unknown>;
}

/** A plugin's main side running as main starts it, over its core. */
export interface TestMainPlugin<D extends PluginDescriptor> {
  readonly plugin: D;
  /** A desktop window's calls to the main side: refused as inactive while core has the plugin off. */
  client(): Client<MembersFor<ChannelsOf<D>, 'main', 'renderer'>>;
  /** Notices delivered so far: `desktop` toasts, and `phone` pushes handed to the phone's transport. */
  notifications(): { desktop: DeliveredNotification[]; phone: DeliveredNotification[] };
  /** Lines written to the diagnostics log so far (activation failures, plugins' own ctx.diag). */
  diagnostics(): Diagnostic[];
  /** The plugin's stored secrets now, by name. */
  secrets(): Record<string, string>;
  /** Channels it asked to bring up to date (ctx.sync). */
  synced(): string[];
  /** Live labels its providers give the channel shown in Discord, while it is on. */
  labels(channelId: string): Promise<Record<string, string[]>>;
  /** A paired phone's request to its declared route; `{ status: 'inactive' }` while it is off. */
  route(name: PhoneRouteNames<D>, request: PhoneRouteRequest): Promise<unknown>;
  /** What a window's harness reaches this main process through. */
  readonly link: MainLink;
  /** The app quits: switch-governed resources stop (`'quit'`). */
  stop(): Promise<void>;
}

/** Starts `main` as main does at startup, over `core`'s host; resolves once its switch-governed resources started. */
export type TestMainPluginFn = <D extends PluginDescriptor>(main: MainPlugin<D>, core: { readonly link: CoreLink }, options?: MainTestOptions) => Promise<TestMainPlugin<D>>;
