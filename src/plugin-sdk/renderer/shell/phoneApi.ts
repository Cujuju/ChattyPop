// Host defines permitted phone calls/events; transport plugins supply delivery only.
import { APP_RESTART_CHANNEL, MAIN_INVOKE, type AppEvent, type RendererApi } from '@shared/contract';
import type { PluginCallResult } from '@shared/pluginCall';
import { isPhoneDeviceSetting, phoneMayCallPlugin, phoneMayWriteSetting, type PhoneCall, type PhoneDiscordMethod } from '@shared/phone';

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
      // Its own settings (PHONE_DEVICE_SETTINGS) and the PC's it may write reach its transport; view choices (density, filters) last this visit.
      method === 'setSetting'
        ? (key: string, value: unknown) =>
            isPhoneDeviceSetting(key) || phoneMayWriteSetting(key) ? transport.call({ group: 'core', method, params: [key, value] }) : Promise.resolve()
        : (...params: unknown[]) => transport.call({ group: 'core', method, params }),
  });

  type DiscordApi = RendererApi['discord'];
  /** A Discord call the phone makes through the desktop (PHONE_DISCORD_METHODS). */
  const relay = <K extends PhoneDiscordMethod>(method: K): DiscordApi[K] =>
    ((...params: unknown[]) => transport.call({ group: 'discord', method, params })) as DiscordApi[K];

  /** A main call the phone makes through the desktop by its channel (PHONE_MAIN_CALLS). */
  const viaMain =
    <F extends (...args: never[]) => Promise<unknown>>(channel: string): F =>
      ((...params: unknown[]) => transport.call({ group: 'main', method: channel, params })) as unknown as F;
  const { openRouter, typeSafe, storage, desktop, marketplace } = MAIN_INVOKE;

  const listeners = new Set<(e: AppEvent) => void>();
  let listening = false;

  const api: RendererApi = {
    core,
    // Sign-in opens the PC's browser; keys typed here travel to the desktop, which encrypts and keeps them.
    openRouter: { signIn: unavailable('OpenRouter sign-in'), addKey: viaMain(openRouter.addKey), updateKey: viaMain(openRouter.updateKey), removeKey: viaMain(openRouter.removeKey) },
    typeSafe: { setKey: viaMain(typeSafe.setKey), removeKey: viaMain(typeSafe.removeKey) },
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
      uploadLimit: relay('uploadLimit'),
      prepareUploads: relay('prepareUploads'),
      uploadChunk: relay('uploadChunk'),
      finishUpload: relay('finishUpload'),
      edit: relay('edit'),
      deleteMessage: relay('deleteMessage'),
      forward: relay('forward'),
      react: relay('react'),
      gifs: relay('gifs'),
      customTheme: viaMain(MAIN_INVOKE.discord.customTheme),
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
      setChatSettings: relay('setChatSettings'),
      // Managing DMs stays on the desktop (docs/dms.md §4.1).
      friends: unavailable('Starting a conversation'),
      startDm: unavailable('Starting a conversation'),
      dmWith: unavailable('Starting a conversation'),
      addToDm: unavailable('Adding people'),
      closeDm: unavailable('Closing a conversation'),
      renameDm: unavailable('Renaming a group'),
      muteDm: unavailable('Muting a conversation'),
    },
    // Moving the archive picks a folder on the PC.
    storage: { info: viaMain(storage.info), move: unavailable('Moving the archive'), deletePrevious: unavailable('Deleting the previous archive'), setEncrypted: viaMain(storage.setEncrypted) },
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
      state: viaMain(desktop.state),
      set: viaMain(desktop.set),
      setOpenAtLogin: viaMain(desktop.setOpenAtLogin),
      setBadge: () => Promise.resolve(),
      setSplashTheme: () => Promise.resolve(),
      checkForUpdate: viaMain(desktop.checkForUpdate),
      installUpdate: viaMain(desktop.installUpdate),
    },
    marketplace: {
      state: viaMain(marketplace.state),
      add: viaMain(marketplace.add),
      remove: viaMain(marketplace.remove),
      setToken: viaMain(marketplace.setToken),
      refresh: viaMain(marketplace.refresh),
      install: viaMain(marketplace.install),
      installLocal: viaMain(marketplace.installLocal),
      uninstall: viaMain(marketplace.uninstall),
      cancel: viaMain(marketplace.cancel),
    },
    openPluginsFolder: unavailable('Opening the plugins folder'),
    restartApp: viaMain(APP_RESTART_CHANNEL),
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
