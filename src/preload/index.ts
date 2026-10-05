import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  APP_EVENT_CHANNEL,
  CORE_INVOKE_CHANNEL,
  DISCORD_OPEN_CHANNEL,
  DISCORD_SIDEBAR_CHANNEL,
  DISCORD_SLOT_CHANNEL,
  MAIN_INVOKE,
  PANEL_WINDOW_CHANNEL,
  PLUGINS_OPEN_FOLDER_CHANNEL,
  APP_RESTART_CHANNEL,
  RENDERER_CORE_METHODS,
  SHOW_IN_MAIN_CHANNEL,
  type AppEvent,
  type DiscordSlot,
  type MainInvokeGroup,
  type RendererApi,
} from '@shared/contract';

// One generic forwarder per renderer-visible core method; adding one to the contract exposes it here.
const core = Object.fromEntries(
  RENDERER_CORE_METHODS.map((m) => [m, (...params: unknown[]) => ipcRenderer.invoke(CORE_INVOKE_CHANNEL, m, params)]),
) as RendererApi['core'];

/** A group's MAIN_INVOKE methods as forwarders; `api` below fails to type-check when a RendererApi method has none. */
function invokers<G extends MainInvokeGroup>(group: G): Pick<RendererApi[G], Extract<keyof (typeof MAIN_INVOKE)[G], keyof RendererApi[G]>> {
  const channels: Record<string, string> = MAIN_INVOKE[group];
  return Object.fromEntries(Object.entries(channels).map(([method, channel]) => [method, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])) as Pick<
    RendererApi[G],
    Extract<keyof (typeof MAIN_INVOKE)[G], keyof RendererApi[G]>
  >;
}

const api: RendererApi = {
  core,
  openRouter: invokers('openRouter'),
  typeSafe: invokers('typeSafe'),
  discord: {
    ...invokers('discord'),
    setSlot: (slot: DiscordSlot) => ipcRenderer.send(DISCORD_SLOT_CHANNEL, slot),
    setSidebar: (sidebar) => ipcRenderer.send(DISCORD_SIDEBAR_CHANNEL, sidebar),
    openChannel: (guildId: string, channelId: string) => ipcRenderer.send(DISCORD_OPEN_CHANNEL, guildId, channelId),
  },
  storage: invokers('storage'),
  plugins: invokers('plugins'),
  rules: invokers('rules'),
  media: invokers('media'),
  desktop: invokers('desktop'),
  marketplace: invokers('marketplace'),
  openPluginsFolder: () => ipcRenderer.invoke(PLUGINS_OPEN_FOLDER_CHANNEL),
  restartApp: () => ipcRenderer.invoke(APP_RESTART_CHANNEL),
  openPanelWindow: (panelId: string) => ipcRenderer.invoke(PANEL_WINDOW_CHANNEL, panelId),
  showInMainWindow: (channelId, messageId, opts) => ipcRenderer.send(SHOW_IN_MAIN_CHANNEL, channelId, messageId, opts?.compose),
  onEvent: (listener: (e: AppEvent) => void) => {
    const handler = (_e: IpcRendererEvent, event: AppEvent): void => listener(event);
    ipcRenderer.on(APP_EVENT_CHANNEL, handler);
    return () => ipcRenderer.off(APP_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('chattypop', api);
