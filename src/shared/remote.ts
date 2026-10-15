// What a remote desktop may reach, whatever transport carries it: the desktop UI served by a ChattyPop server to
// another machine (docs/remote.md). It acts with the renderer audience, as the server's own
// window does, less what needs the server's screen or disk.
import { rendererGetsEvent } from './bundledPlugins';
import { RENDERER_CORE_METHODS } from './rendererApi';
import { isRemoteDeviceSetting } from './remoteDevice';
import { APP_RESTART_CHANNEL, MAIN_INVOKE, PLUGINS_OPEN_FOLDER_CHANNEL, type AppEvent } from './types/ipc';

/** Main calls a remote desktop answers itself (its shell or page): they never reach the server. */
export const REMOTE_LOCAL_MAIN_CALLS: readonly string[] = [
  MAIN_INVOKE.desktop.setBadge,
  MAIN_INVOKE.desktop.setSplashTheme,
  MAIN_INVOKE.media.saveAttachment,
  MAIN_INVOKE.media.savePdf,
];

/** Main calls that act on the server's screen or disk; a remote desktop is refused them. */
export const REMOTE_REFUSED_MAIN_CALLS: readonly string[] = [
  MAIN_INVOKE.media.beginReplacement,
  MAIN_INVOKE.media.replacementChunk,
  MAIN_INVOKE.media.finishReplacement,
  MAIN_INVOKE.media.abortReplacement,
  // Opens the server's browser for OAuth.
  MAIN_INVOKE.openRouter.signIn,
  // Pick a folder or a file on the server's screen; a typed path (a rule file, a local plugin) still crosses.
  MAIN_INVOKE.storage.move,
  MAIN_INVOKE.rules.pickFile,
  PLUGINS_OPEN_FOLDER_CHANNEL,
];

/** Groups a remote desktop reaches through the `main` call group, by channel; Discord and plugin calls have their own groups. */
const MAIN_GROUPS = ['openRouter', 'typeSafe', 'providerKeys', 'storage', 'rules', 'media', 'desktop', 'marketplace'] as const;
const notCrossing = new Set([...REMOTE_LOCAL_MAIN_CALLS, ...REMOTE_REFUSED_MAIN_CALLS]);

/** Main calls a remote desktop may make, by channel: the window groups' calls neither local nor refused, and restart. */
export const REMOTE_MAIN_CALLS: readonly string[] = [
  ...MAIN_GROUPS.flatMap((g) => Object.values<string>(MAIN_INVOKE[g])).filter((channel) => !notCrossing.has(channel)),
  APP_RESTART_CHANNEL,
];
const mainCalls = new Set(REMOTE_MAIN_CALLS);
/** Whether a remote desktop may make main call `channel` (REMOTE_MAIN_CALLS). */
export const remoteMayCallMain = (channel: string): boolean => mainCalls.has(channel);

/** Discord calls a remote desktop may make: every one the window invokes. The live pane's (setSlot, setSidebar, openChannel) stay local. */
export const REMOTE_DISCORD_METHODS = Object.keys(MAIN_INVOKE.discord) as (keyof typeof MAIN_INVOKE.discord)[];
export type RemoteDiscordMethod = (typeof REMOTE_DISCORD_METHODS)[number];
const discordMethods = new Set<string>(REMOTE_DISCORD_METHODS);
export const remoteMayCallDiscord = (method: string): method is RemoteDiscordMethod => discordMethods.has(method);

export const SERVER_SCREEN_CORE_METHODS = ['linkProviderAccount', 'submitAccountLinkCode', 'cancelAccountLink'] as const;
const coreMethods = new Set<string>(RENDERER_CORE_METHODS.filter((method) => !(SERVER_SCREEN_CORE_METHODS as readonly string[]).includes(method)));
/** A core call a remote desktop may make: every one the window may (RENDERER_CORE_METHODS). */
export const remoteMayCallCore = (method: string): boolean => coreMethods.has(method);

export { REMOTE_DEVICE_SETTINGS, isRemoteDeviceSetting } from './remoteDevice';

/**
 * An event as a remote desktop gets it: what the server's window gets (plugin events whose audiences include the
 * renderer), except changes to settings the desktop keeps for itself, which its transport sends.
 */
export function remoteAppEvent(e: AppEvent): AppEvent | null {
  if (e.type === 'account-link') return null;
  if (e.type === 'plugin-event') return rendererGetsEvent(e.pluginId, e.name) ? e : null;
  if (e.type === 'setting-changed' && isRemoteDeviceSetting(e.key)) return null;
  return e;
}

/**
 * Whether an event is worth only the moment it is sent: a sign-in relay's frame, which the next one replaces. A
 * transport sends it to the desktops connected now and keeps none for a desktop that reconnects.
 */
export const momentaryAppEvent = (e: AppEvent): boolean => e.type === 'discord-login-frame';
