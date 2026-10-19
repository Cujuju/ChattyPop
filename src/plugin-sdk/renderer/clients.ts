// Plugin SDK, renderer: typed channel clients (docs/plugin-architecture.md §5), exact to the audiences each member serves.
// A leaf over the @/api transport: nothing runs until a member is called.
import { callCore, type CallOptions } from './call';
import { api, windowAudience } from '@/api';
import type { ChannelsOf, PluginDescriptor } from '@shared/bundledTypes';
import { audiencesOf, clientOver, type Client, type MembersFor } from '@shared/pluginChannels';

/** The audiences a window's calls carry: a desktop window's, or the phone's page. */
export type WindowAudience = 'renderer' | 'phone';
type DesktopMembers<D> = MembersFor<ChannelsOf<D>, 'core', 'renderer'>;
type PhoneMembers<D> = MembersFor<ChannelsOf<D>, 'core', 'phone'>;
type CommonMember<D> = keyof DesktopMembers<D> & keyof PhoneMembers<D>;
/** Core calls any window may make: the member names `coreClient` types. */
export type WindowMember<D> = keyof MembersFor<ChannelsOf<D>, 'core', WindowAudience> & string;
/** Core calls for code either window runs: members served to both are there; one window's alone are there only in it. */
export type WindowClient<D> = Client<Pick<DesktopMembers<D>, CommonMember<D>>> &
  Partial<Client<Omit<DesktopMembers<D>, CommonMember<D>>>> &
  Partial<Client<Omit<PhoneMembers<D>, CommonMember<D>>>>;

/** A client whose members are exactly the core calls declared for `audience()`; any other name reads undefined. */
function coreFor<T>(plugin: PluginDescriptor, audience: () => WindowAudience, options?: CallOptions): T {
  return new Proxy({} as object, {
    get: (_target, name) => typeof name === 'string' && name !== 'then' && audiencesOf(plugin.channels, 'core', name).includes(audience())
      ? (...args: unknown[]) => callCore(plugin.manifest.id, name, args, options) : undefined,
  }) as T;
}

/** Core calls for code either window runs; a member this window's audience lacks is undefined (the type makes it optional). */
export const coreClient = <D extends PluginDescriptor>(plugin: D, options?: CallOptions): WindowClient<D> => coreFor(plugin, windowAudience, options);

/** Core calls for code only desktop windows run (settings, desktop-only panels and menus). The phone's transport refuses them. */
export const desktopCoreClient = <D extends PluginDescriptor>(plugin: D, options?: CallOptions): Client<DesktopMembers<D>> => coreFor(plugin, () => 'renderer', options);

/** Core calls for code only the phone's page runs. */
export const phoneCoreClient = <D extends PluginDescriptor>(plugin: D, options?: CallOptions): Client<PhoneMembers<D>> => coreFor(plugin, () => 'phone', options);

/** Main calls, for desktop windows only (main serves windows alone). */
export const mainClient = <D extends PluginDescriptor>(plugin: D): Client<MembersFor<ChannelsOf<D>, 'main', 'renderer'>> =>
  clientOver((name, args) => api.plugins.callMain(plugin.manifest.id, name, args));
