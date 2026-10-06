// Host defines permitted phone calls/events; transport plugins supply delivery only.
import type { AppEvent, RendererApi } from '@shared/contract';
import type { PluginCallResult } from '@shared/pluginCall';
import { phoneMayCallPlugin, type PhoneCall, type PhoneDiscordMethod } from '@shared/phone';

/** How a phone page reaches the desktop. */
export interface PhoneTransport {
  /** Sends one call to the desktop and resolves with its result (DesktopUnreachableError when nothing answers). */
  call(call: PhoneCall): Promise<unknown>;
  /** Starts delivering the desktop's app events to `deliver`; called once, when the page first subscribes. */
  listen(deliver: (e: AppEvent) => void): void;
}

declare const phoneApi: unique symbol;
/** The renderer API a phone page installs; only createPhoneRendererApi makes one, so an installed API is always the phone's. */
export type PhoneRendererApi = RendererApi & { readonly [phoneApi]: true };

const unavailable = (what: string) => (): Promise<never> => Promise.reject(new Error(`${what} is only on the desktop.`));
const ignored = (): void => {};

/** The phone's renderer API over `transport`: calls the phone may make travel; the rest refuse or do nothing. */
export function createPhoneRendererApi(transport: PhoneTransport): PhoneRendererApi {
  const core = new Proxy({} as RendererApi['core'], {
    get: (_t, method: string) =>
      // The phone keeps its own view choices (density, filters) for this visit; the desktop's settings stay as they are.
      method === 'setSetting' ? () => Promise.resolve() : (...params: unknown[]) => transport.call({ group: 'core', method, params }),
  });

  type DiscordApi = RendererApi['discord'];
  /** A Discord call the phone makes through the desktop (PHONE_DISCORD_METHODS). */
  const relay = <K extends PhoneDiscordMethod>(method: K): DiscordApi[K] =>
    ((...params: unknown[]) => transport.call({ group: 'discord', method, params })) as DiscordApi[K];

  const listeners = new Set<(e: AppEvent) => void>();
  let listening = false;

  const api: RendererApi = {
    core,
    openRouter: { signIn: unavailable('OpenRouter sign-in'), addKey: unavailable('Key setup'), updateKey: unavailable('Key setup'), removeKey: unavailable('Key setup') },
    typeSafe: { setKey: unavailable('Key setup'), removeKey: unavailable('Key setup') },
    discord: {
      setSlot: ignored,
      setSidebar: ignored,
      openChannel: ignored,
      probe: unavailable('Discord diagnostics'),
      shownChannel: () => Promise.resolve(null),
      refreshDirectory: unavailable('Refreshing servers'),
      setOptIn: unavailable('Choosing archived channels'),
      suggestChannels: unavailable('Channel suggestions'),
      send: relay('send'),
      edit: relay('edit'),
      deleteMessage: relay('deleteMessage'),
      forward: relay('forward'),
      react: relay('react'),
      gifs: relay('gifs'),
      customTheme: unavailable('Importing a Discord theme'),
      expressions: relay('expressions'),
      commands: relay('commands'),
      runCommand: relay('runCommand'),
      autocomplete: relay('autocomplete'),
      useComponent: relay('useComponent'),
      submitModal: relay('submitModal'),
      roles: relay('roles'),
      requestMembers: relay('requestMembers'),
      createThread: relay('createThread'),
      sendDirect: relay('sendDirect'),
      profile: relay('profile'),
      mutualFriends: relay('mutualFriends'),
      reactors: relay('reactors'),
      // Managing DMs stays on the desktop (docs/dms.md §4.1).
      friends: unavailable('Starting a conversation'),
      startDm: unavailable('Starting a conversation'),
      dmWith: unavailable('Starting a conversation'),
      addToDm: unavailable('Adding people'),
      closeDm: unavailable('Closing a conversation'),
      renameDm: unavailable('Renaming a group'),
      muteDm: unavailable('Muting a conversation'),
    },
    storage: { info: unavailable('Storage'), move: unavailable('Moving the archive'), deletePrevious: unavailable('Storage'), setEncrypted: unavailable('Encryption') },
    plugins: {
      // A member whose audiences leave out the phone fails here, not at the desktop.
      callCore: (pluginId, name, args) =>
        phoneMayCallPlugin(pluginId, name)
          ? (transport.call({ group: 'plugins', method: 'callCore', params: [pluginId, name, args] }) as Promise<PluginCallResult>)
          : unavailable('This plugin feature')(),
      callMain: unavailable('This plugin feature'),
    },
    rules: { pickFile: unavailable('Rule files') },
    // The phone's page saves through its browser: the media route is its own origin, so a download link works there.
    media: { saveAttachment: unavailable('Saving files') },
    desktop: {
      state: unavailable('Desktop settings'),
      set: unavailable('Desktop settings'),
      setOpenAtLogin: unavailable('Desktop settings'),
      setBadge: () => Promise.resolve(),
      checkForUpdate: unavailable('Updates'),
      installUpdate: unavailable('Updates'),
    },
    marketplace: {
      state: unavailable('Plugin marketplaces'),
      add: unavailable('Plugin marketplaces'),
      remove: unavailable('Plugin marketplaces'),
      setToken: unavailable('Plugin marketplaces'),
      refresh: unavailable('Plugin marketplaces'),
      install: unavailable('Plugin marketplaces'),
      installLocal: unavailable('Plugin marketplaces'),
      uninstall: unavailable('Plugin marketplaces'),
      cancel: unavailable('Plugin marketplaces'),
    },
    openPluginsFolder: unavailable('The plugins folder'),
    restartApp: unavailable('Restarting ChattyPop'),
    openPanelWindow: () => Promise.resolve(),
    showInMainWindow: ignored,
    onEvent: (listener) => {
      listeners.add(listener);
      if (!listening) {
        listening = true;
        transport.listen((e) => listeners.forEach((l) => l(e)));
      }
      return () => listeners.delete(listener);
    },
  };
  return api as PhoneRendererApi;
}
