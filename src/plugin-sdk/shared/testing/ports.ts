// What the test harnesses' links stand for (docs/plugin-architecture.md §15): each process as the next one's transport
// reaches it. Harness internals; never exported from a testing entry.
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import type { PluginCallResult } from '@shared/pluginCall';
import type { PhoneCall } from '@shared/phone';
import type { CoreLink, MainLink } from './index';

/** A core harness as its transports reach it. */
export interface CorePort {
  /** Every installed plugin's descriptor, in build order. */
  readonly installed: readonly PluginDescriptor[];
  /** The archive's media folder, which main shares. */
  readonly mediaDir: string;
  /** The test's profile folder, removed on dispose. */
  readonly profileDir: string;
  /** A core service call as it crosses the process boundary: structured clones both ways, a failure by its message. */
  call(method: string, ...params: unknown[]): Promise<unknown>;
  /** A phone's call through the host's phone gateway, which stamps it as the phone's. */
  phone(call: PhoneCall): Promise<unknown>;
  /** Core's app events, as main receives them; returns an unsubscribe function. */
  on(fn: (e: AppEvent) => void): () => void;
  /** Awaited by off() and on() after the host switched: a linked main side's resources follow the switch. */
  readonly afterSwitch: (() => Promise<void>)[];
}

/** A main harness as windows reach it. */
export interface MainPort {
  /** A desktop window's call to a plugin's main side. */
  callMain(pluginId: string, name: string, args: unknown[]): Promise<PluginCallResult>;
  /** Events main sends desktop windows (core's, and its plugins'); returns an unsubscribe function. */
  on(fn: (e: AppEvent) => void): () => void;
  /** Events main's phone hub hands the phone's transport, before its wire codec; returns an unsubscribe function. */
  onPhone(fn: (e: AppEvent) => void): () => void;
}

const cores = new WeakMap<CoreLink, CorePort>();
const mains = new WeakMap<MainLink, MainPort>();

/** A new link to `port`. */
export function coreLink(port: CorePort): CoreLink {
  const link: CoreLink = { coreLink: true };
  cores.set(link, port);
  return link;
}

export function mainLink(port: MainPort): MainLink {
  const link: MainLink = { mainLink: true };
  mains.set(link, port);
  return link;
}

/** The core a link reaches; throws for a link that isn't one or whose harness was disposed. */
export function corePort(link: CoreLink): CorePort {
  const port = cores.get(link);
  if (!port) throw new Error('Not a live link from @plugin-sdk/core/testing.');
  return port;
}

export function mainPort(link: MainLink): MainPort {
  const port = mains.get(link);
  if (!port) throw new Error('Not a live link from @plugin-sdk/main/testing.');
  return port;
}

/** Retires a disposed core harness's link. */
export const unlinkCore = (link: CoreLink): void => void cores.delete(link);
