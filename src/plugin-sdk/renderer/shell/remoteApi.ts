// A remote desktop's renderer API: the desktop UI a ChattyPop server serves to another machine. Calls travel as a
// window's (the transport's desktop gateway, src/shared/remote.ts); what the device does itself goes to the client
// app's shell (src/shared/desktopShell.ts), or the browser when there is none.
import { APP_RESTART_CHANNEL, MAIN_INVOKE, type AppEvent, type RendererApi } from '@shared/contract';
import type { DesktopShell } from '@shared/desktopShell';
import { attachmentUrl, savedFileName, setMediaRoot } from '@shared/media';
import { targetEvent, type DeliveredNotification } from '@shared/notifications';
import type { PluginCallResult } from '@shared/pluginCall';
import { SERVER_SCREEN_CORE_METHODS } from '@shared/remote';
import { installApi } from '@/api';
import { setPageOpener } from '@/ui/exportPage';
import type { ExportFormat, HtmlPage, PdfPage } from '@shared/htmlPage';
import type { PhoneTransport } from './phoneApi';

/** How a remote desktop page reaches its server: the phone's transport, plus notices for this desktop. */
export interface RemoteTransport extends PhoneTransport {
  /** Starts delivering the notices the server sends this desktop; called once, with listen, when the page first subscribes. */
  notifications(deliver: (n: DeliveredNotification) => void): void;
}

type Opener = (page: Promise<HtmlPage | PdfPage>, format: ExportFormat) => void;
declare const remoteApi: unique symbol;
/** The renderer API a remote desktop page installs; only createRemoteRendererApi makes one. `openExport`: in a browser, the transport's. */
export type RemoteRendererApi = RendererApi & { readonly [remoteApi]: true; readonly openExport?: Opener };

const ONLY_ON_SERVER = 'is only on the server.';
const serverOnly = (what: string) => (): Promise<never> => Promise.reject(new Error(`${what} ${ONLY_ON_SERVER}`));
const ignored = (): void => {};

/** The panel window `panelId` opens on in a browser tab: this page, showing that panel alone. */
const panelUrl = (panelId: string): string => `${location.pathname}?${new URLSearchParams({ panel: panelId })}`;

/** Shows a notice in a browser that allows notifications (the client app's shell does it otherwise). */
function browserNotify(n: DeliveredNotification, local: (e: AppEvent) => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const shown = new Notification(n.title, { body: n.body });
  shown.onclick = () => {
    window.focus();
    const opens = targetEvent(n.target);
    if (opens) local(opens);
  };
}

/** Saves a file the page's own origin serves, as a browser download. */
function download(href: string, fileName: string): void {
  Object.assign(document.createElement('a'), { href, download: fileName }).click();
}

/** The remote desktop's renderer API over `transport`; `shell` is the client app's (desktopShell()), null in a browser. */
export function createRemoteRendererApi(transport: RemoteTransport, shell: DesktopShell | null): RemoteRendererApi {
  const call = (group: 'core' | 'discord' | 'plugins' | 'main', method: string, params: unknown[]): Promise<unknown> =>
    transport.call({ group, method, params });
  const core = new Proxy({} as RendererApi['core'], { get: (_t, method: string) => (...params: unknown[]) => (SERVER_SCREEN_CORE_METHODS as readonly string[]).includes(method) ? serverOnly('Account sign-in')() : call('core', method, params) });
  type Group = 'openRouter' | 'typeSafe' | 'providerKeys' | 'storage' | 'desktop' | 'marketplace';
  /** A group's main calls, each by its channel. */
  const viaMain = <G extends Group>(group: G): RendererApi[G] =>
    Object.fromEntries(Object.entries<string>(MAIN_INVOKE[group]).map(([name, channel]) => [name, (...params: unknown[]) => call('main', channel, params)])) as unknown as RendererApi[G];
  const discordCalls = Object.fromEntries(Object.keys(MAIN_INVOKE.discord).map((name) => [name, (...params: unknown[]) => call('discord', name, params)]));

  /** Listeners for this window's own commands: a notice clicked, a panel window's show-in-main. */
  const local = new Set<(e: AppEvent) => void>();
  const deliverLocal = (e: AppEvent): void => local.forEach((l) => l(e));
  shell?.onLocalEvent(deliverLocal);

  const listeners = new Set<(e: AppEvent) => void>();
  let listening = false;

  const api: RendererApi = {
    core,
    openRouter: { ...viaMain('openRouter'), signIn: serverOnly('Signing in to OpenRouter') },
    typeSafe: viaMain('typeSafe'),
    providerKeys: viaMain('providerKeys'),
    discord: {
      ...(discordCalls as Omit<RendererApi['discord'], 'setSlot' | 'setSidebar' | 'openChannel'>),
      // The live client is on the server's screen only.
      setSlot: ignored,
      setSidebar: ignored,
      openChannel: ignored,
    },
    storage: { ...viaMain('storage'), move: serverOnly('Moving the archive') },
    plugins: {
      callCore: (pluginId, name, args) => call('plugins', 'callCore', [pluginId, name, args]) as Promise<PluginCallResult>,
      callMain: (pluginId, name, args) => call('plugins', 'callMain', [pluginId, name, args]) as Promise<PluginCallResult>,
    },
    marketplace: viaMain('marketplace'),
    rules: { pickFile: serverOnly('Choosing a rule file') },
    media: {
      beginReplacement: serverOnly('Compressing stored attachments'),
      replacementChunk: serverOnly('Compressing stored attachments'),
      finishReplacement: serverOnly('Compressing stored attachments'),
      abortReplacement: serverOnly('Compressing stored attachments'),
      saveAttachment: (file) => {
        const path = attachmentUrl(file);
        const filename = savedFileName(file);
        if (shell) return shell.saveMedia(path, filename);
        download(path, filename);
        return Promise.resolve();
      },
      savePdf: (page) => {
        if (shell) return shell.savePdf(page);
        if (transport.openExport) return Promise.resolve(transport.openExport(Promise.resolve(page), 'pdf'));
        return Promise.reject(new Error('Saving a PDF needs the ChattyPop app.'));
      },
    },
    desktop: {
      ...viaMain('desktop'),
      setBadge: (unread) => Promise.resolve(shell?.setBadge(unread)),
      setSplashTheme: () => Promise.resolve(),
    },
    openPluginsFolder: serverOnly('Opening the plugins folder'),
    restartApp: () => call('main', APP_RESTART_CHANNEL, []) as Promise<void>,
    openPanelWindow: (panelId) => {
      if (shell) shell.openPanelWindow(panelId);
      else window.open(panelUrl(panelId), '_blank');
      return Promise.resolve();
    },
    showInMainWindow: (channelId, messageId, opts) => shell?.showInMainWindow(channelId, messageId, opts?.compose),
    reportShownChannel: (channelId) => shell?.reportShownChannel?.(channelId),
    getShownChannel: () => shell?.getShownChannel?.() ?? Promise.resolve(null),
    setUnsaved: (on) => shell?.setUnsaved(on),
    discardUnsaved: () => shell?.discardUnsaved(),
    onEvent: (listener) => {
      listeners.add(listener);
      local.add(listener);
      if (!listening) {
        listening = true;
        transport.listen((e) => listeners.forEach((l) => l(e)));
        transport.notifications((n) => (shell ? shell.notify(n) : browserNotify(n, deliverLocal)));
      }
      return () => {
        listeners.delete(listener);
        local.delete(listener);
      };
    },
  };
  // In the app, exports save through its dialogs; in a browser, the transport opens them (as on the phone).
  const openExport: Opener | null = !shell && transport.openExport ? (page, format) => transport.openExport!(page, format) : null;
  return { ...api, ...(openExport ? { openExport } : {}) } as RemoteRendererApi;
}

/**
 * Installs a remote desktop's API and media root, then starts the app (or the panel this window shows). The page's
 * root must already say `data-surface="remote"`, before any host module loads.
 */
export async function startRemoteDesktop(api: RemoteRendererApi, mediaRoot: string): Promise<void> {
  setMediaRoot(mediaRoot);
  setPageOpener(api.openExport ?? null);
  installApi(api);
  // The app's own chunk: a phone page sharing this SDK tier never loads it.
  const { startApp } = await import('@/boot');
  startApp();
}
