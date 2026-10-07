// Electron wiring for the archive, Discord view and plugins. Main's boot entry (index.ts) imports it once what must
// precede 'ready' is done and installed plugins are decided.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain, session, shell } from 'electron';
import { callMain, handleMain } from './ipc/mainCalls';
import {
  CORE_INVOKE_CHANNEL,
  PANEL_WINDOW_CHANNEL,
  PLUGINS_OPEN_FOLDER_CHANNEL,
  APP_RESTART_CHANNEL,
  RENDERER_CORE_METHODS,
  SHOW_IN_MAIN_CHANNEL,
  isArchivedGatewayEvent,
  isComposeIntent,
  type AppEvent,
  type CoreInitStep,
  type CoreMethod,
  type PendingAttachment,
} from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { SETTINGS_KEYS } from '@shared/settings';
import type { SplashPhaseId } from '@shared/splash.mjs';
import { loadArchiveKey } from './archiveKey';
import { CoreClient } from './coreClient';
import { routeCoreEvents } from './coreEvents';
import { diag } from './diagnostics';
import { pickFiles, pickFolder } from './dialogs';
import { SECRET_FILES } from './secretFile';
import { DiscordApi } from './discord/api';
import { HeaderCapture } from './discord/capture';
import { GuildEmojiIndex } from './discord/guildEmojis';
import { ReadStates } from './discord/readStates';
import { watchPrivateChannels } from './discord/privateChannels';
import { watchGuildOrder } from './discord/guildOrder';
import { AccountChatSettings } from './discord/chatSettings';
import { LiveLabelProviders } from './discord/labelProviders';
import { LiveLabels } from './discord/liveLabels';
import { discordFontUrl } from './discord/pageFonts';
import { GatewayAccess } from './discord/access';
import { gatewayGuildRoles } from './discord/roles';
import { TypingEvents } from './discord/typing';
import { DISCORD_PARTITION, type DiscordView } from './discordView';
import { registerDiscordHandlers } from './ipc/discord';
import { registerKeyHandlers } from './ipc/keys';
import { registerRuleHandlers } from './ipc/rules';
import { registerMediaHandlers } from './ipc/media';
import { registerStorageHandlers } from './ipc/storage';
import { restartApp } from './restart';
import { registerMarketplaceHandlers } from './marketplace/ipc';
import { buildFromSource } from './marketplace/sourceBuild';
import { Desktop } from './desktop';
import { createMainWindow, loadRenderer, rendererWindowOptions } from './mainWindow';
import { startSplash } from './splash';
import { AttachmentDownloader, freshAttachmentUrl } from './media/attachmentDownloader';
import { mediaDirs, removeLegacyCaches } from './media/mediaDirs';
import { handleMediaScheme, mediaHandler } from './media/mediaProtocol';
import { attachmentPoster, fetchImageTo, fetchVideoTo, posterKept, type PosterSource } from './media/thumbStore';
import { PanelWindows } from './panelWindows';
import { PhoneHub, type DiscordCalls } from './phone/hub';
import bundledMain, { failed as failedMain } from 'virtual:bundled-plugins/main';
import { startMainPlugins } from './plugins/bundled';
import { pluginDataDirs } from './plugins/dataDir';
import { installedFiles } from './plugins/installedFiles';
import { installedStart } from './plugins/installed/runtime';
import { rendererPages } from './plugins/pages';
import { postingGate } from './plugins/posting';
import { PluginStates } from './plugins/states';
import { handleInstalledScheme, handlePluginScheme } from './pluginProtocol';
import { archiveDir, profilePath } from './storageLocation';
import { type Publication, TailnetServe, runTailscale } from './tailnet';
import { Pace } from './sync/pace';
import { SyncService } from './sync/syncService';
import { raiseWindow } from './windowState';

/** In-memory session for third-party media (X images): no Discord cookies, nothing persisted. */
const WEB_MEDIA_PARTITION = 'web-media';

const APP_USER_MODEL_ID = 'com.cujuju.chattypop';
/** Plugin folders live in the app profile: they are code and settings, not archive data. */
const PLUGINS_DIR = 'plugins';
/** Profile file recording the Tailscale Serve config plugins set, so the host can remove it without them. */
const TAILNET_RECORDS_FILE = 'tailnet-serve.json';
/** Serve config the Companion set before the record file existed (frozen values), so a profile without one can remove it. */
const UNRECORDED_TAILNET: readonly Publication[] = [{ pluginId: 'companion', httpsPort: 8443, target: 'http://127.0.0.1:47831' }];
/** out/main: this module is its own build entry (electron.vite.config.ts), so it sits beside core.js. */
const here = import.meta.dirname;
/** out/renderer, next to out/main where this module is bundled: the built windows and plugin pages. */
const RENDERER_DIR = join(here, '../renderer');
const rendererCoreMethods = new Set<string>(RENDERER_CORE_METHODS);
/** The splash step each core init milestone ends. */
const SPLASH_STEP_OF_CORE: Record<CoreInitStep, SplashPhaseId> = { loaded: 'core', database: 'database' };

// Stays synchronous (no await): gateway tap listeners must attach in the window's creation tick, or READY is missed.
void app.whenReady().then(() => {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  const dataDir = archiveDir();
  mkdirSync(dataDir, { recursive: true });
  const pluginsDir = profilePath(PLUGINS_DIR);
  mkdirSync(pluginsDir, { recursive: true });
  let key: string | null = null;
  try {
    key = loadArchiveKey();
  } catch (err) {
    // Another Windows account, or a damaged key file: the archive can't be opened, and core reports why.
    diag('archive-key-unreadable', { message: errorMessage(err) });
  }
  const core = new CoreClient(join(here, 'core.js'), { archiveDir: dataDir, pluginsDir, pluginData: pluginDataDirs(), key });
  registerKeyHandlers(core);

  // Capture must be installed before the Discord view loads, or its first API requests are missed.
  const discordSession = session.fromPartition(DISCORD_PARTITION);
  const capture = new HeaderCapture(discordSession);
  const pace = new Pace(core);
  const currentPace = (): ReturnType<Pace['current']> => pace.current();
  // The API runs inside the Discord page, which exists once the window is created below.
  let discordRef: DiscordView | undefined;
  const discordApi = new DiscordApi(() => discordRef, capture, currentPace);
  const media = mediaDirs(dataDir);
  removeLegacyCaches(media);
  const mediaSessions = { discord: discordSession, web: session.fromPartition(WEB_MEDIA_PARTITION) };
  const posterOf = (a: PendingAttachment): PosterSource => ({ stored: a.url, fresh: () => freshAttachmentUrl(discordApi, a) });
  const posterSource = async (id: string): Promise<PosterSource | null> => {
    const a = await core.call('attachmentSource', id);
    return a ? posterOf(a) : null;
  };
  const serveMedia = mediaHandler(media, mediaSessions, (family) => discordFontUrl(discordRef, family), posterSource);
  handleMediaScheme(serveMedia);
  handlePluginScheme(core);
  // The installed plugins main accepted at start, for windows and the phone page.
  const installed = installedFiles(installedStart().accepted);
  handleInstalledScheme(installed);
  /** Set while the archive is being moved: downloads and sync stop writing to it. */
  let archiveMoving = false;
  const downloader = new AttachmentDownloader(
    media.attachments,
    media.emojis,
    discordSession,
    discordApi,
    core,
    currentPace,
    async () => !archiveMoving && (await pace.syncEnabled()),
    { kept: (id) => posterKept(media.previews, id), keep: (a) => attachmentPoster(mediaSessions, media.previews, a.id, async () => posterOf(a)) },
  );

  ipcMain.handle(CORE_INVOKE_CHANNEL, (_e, method: string, params: unknown[]) => {
    if (!rendererCoreMethods.has(method)) throw new Error(`core method not available to renderer: ${method}`);
    return core.call(method as CoreMethod, ...(params as []));
  });

  const desktop = new Desktop();
  const { win, discord } = createMainWindow(desktop);
  const splash = startSplash(win, desktop.startHidden);
  core.on('init-step', (step) => splash.finish(SPLASH_STEP_OF_CORE[step]));
  // Core answers only once its init is done, so its first answer marks the archive open.
  void core.call('selfId').then(() => splash.finish('archive'), () => undefined);
  win.webContents.once('did-finish-load', () => splash.finish('interface'));
  app.on('second-instance', () => raiseWindow(win));
  discordRef = discord;
  const emojiIndex = new GuildEmojiIndex(discord.tap);
  // Discord's unread mention counts for the sidebar; a channel read in ChattyPop is acknowledged on Discord.
  const readStates = new ReadStates(
    discord.tap,
    discordApi,
    (counts, scope) => void core.call('putReadStates', counts, scope),
    diag,
  );
  core.on('event', (e) => {
    if (e.type === 'channel-read') readStates.ack(e.channelId, e.messageId);
  });
  // The signed-in account and its DM list, from READY: no request.
  watchPrivateChannels(discord.tap, core, diag);
  // Servers in the owner's Discord sidebar order, from READY's settings and their updates.
  watchGuildOrder(discord.tap, (guildIds) => void core.call('putGuildOrder', guildIds), diag);
  // The account's Chat settings, from READY and their updates: every window and phone reads them from the archive.
  const chatSettings = new AccountChatSettings(discord.tap, discordApi.prompt, (settings) => core.call('setSetting', SETTINGS_KEYS.discordChat, settings), diag);
  const panelWindows = new PanelWindows(win, loadRenderer, rendererWindowOptions());
  ipcMain.handle(PANEL_WINDOW_CHANNEL, (_e, panelId: unknown) => {
    if (typeof panelId === 'string') panelWindows.show(panelId);
  });

  // Which bundled plugins are on: live labels, main-side resources and phone routes follow it.
  const states = new PluginStates(() => core.call('plugins'), (error) => diag('plugin-states-failed', { message: errorMessage(error) }));
  core.on('event', (e) => { if (e.type === 'plugins-changed') states.refresh(); });
  // Tag pills in the live client, for the channel it shows.
  const labelProviders = new LiveLabelProviders((id) => states.active(id), (id, error) => diag('plugin-labels-failed', { id, message: errorMessage(error) }));
  const liveLabels = new LiveLabels(
    () => discordRef?.webContents,
    (channelId) => labelProviders.read(channelId),
    (message) => diag('live-labels-failed', { message }),
  );
  discord.onDomReady = () => liveLabels.documentReady();
  states.onChange(() => liveLabels.changed());
  states.refresh();
  // The Discord calls exist once their handlers are registered (below); a transport connects only after that.
  let discordCalls: DiscordCalls | undefined;
  const phone = new PhoneHub({ core, discord: () => discordCalls!, main: callMain, media: serveMedia, active: (id) => states.active(id) });
  const { toRenderer, toMain, publish, notifications } = routeCoreEvents({ win, panelWindows, core, downloader, phone });
  desktop.attach(win, toRenderer);
  ipcMain.on(SHOW_IN_MAIN_CHANNEL, (_e, channelId: unknown, messageId: unknown, compose: unknown) => {
    if (typeof channelId !== 'string' || !raiseWindow(win)) return;
    toMain({ type: 'open-message', channelId, ...(typeof messageId === 'string' ? { messageId, ...(isComposeIntent(compose) ? { compose } : {}) } : {}) });
  });
  downloader.kick();

  // Privacy mode in the live client and in what main forwards of its traffic: read at start (core queues the call behind
  // its init), then on each change.
  const typingEvents = new TypingEvents(diag);
  const applyPrivacy = (): void =>
    void core.call('privacyScope').then(
      (scope) => {
        discord.setPrivacy(scope);
        typingEvents.setPrivacy(scope);
      },
      (err: unknown) => diag('privacy-scope-failed', { message: errorMessage(err) }),
    );
  core.on('event', (e) => {
    if (e.type === 'privacy-changed') applyPrivacy();
  });
  applyPrivacy();

  discord.onChannel = (guildId, channelId) => {
    toRenderer({ type: 'live-channel', guildId, channelId });
    liveLabels.showChannel(channelId);
  };
  const sync = new SyncService(discordApi, core, toRenderer);
  // A channel archived (by the owner, or a DM by auto-archive) syncs its history.
  core.on('event', (e) => {
    if (e.type === 'opt-in-changed' && e.optedIn) sync.enqueue(e.optedIn);
    // Sync keeps only the signed-in account's DMs: READY naming one queues them.
    if (e.type === 'self-changed') void sync.signedIn(e.userId);
  });
  capture.onAvailable = () => void sync.syncAll();
  sync.onSettled = () => void core.call('syncSettled');
  const gatewayAccess = new GatewayAccess();
  discord.tap.on('dispatch', ({ t, d }) => {
    if (isArchivedGatewayEvent(t)) void core.call('applyGatewayEvent', t, d);
    const typing = typingEvents.read(t, d);
    if (typing) toRenderer(typing);
    for (const g of gatewayGuildRoles(t, d)) void core.call('replaceGuildRoles', g.guildId, g.roles);
    const access = gatewayAccess.read(t, d);
    if (access && (access.owners.length || access.overwrites.length || access.members.length)) void core.call('applyAccessFacts', access);
  });

  registerStorageHandlers({
    win,
    core,
    emit: toRenderer,
    stopArchive: async () => {
      archiveMoving = true;
      sync.halt();
      await core.call('closeArchive');
    },
  });
  registerMarketplaceHandlers({ build: buildFromSource });
  ipcMain.handle(PLUGINS_OPEN_FOLDER_CHANNEL, async () => void (await shell.openPath(pluginsDir)));
  handleMain(APP_RESTART_CHANNEL, () => restartApp(win));
  // Posting calls ask core's plugin list each time: a plugin declaring unlocks.posting must be on.
  const posting = postingGate(() => core.call('plugins'));
  discordCalls = registerDiscordHandlers({ win, core, sync, owner: discordApi.prompt, capture, discord, emojiIndex, readStates, posting, discordSession, chatSettings });
  const pages = rendererPages(RENDERER_DIR, process.env['ELECTRON_RENDERER_URL'] ?? null, installed);
  for (const { id, error } of failedMain) diag('installed-plugin-load-failed', { pluginId: id, message: error });
  const mainPlugins = startMainPlugins(bundledMain, {
    notifications,
    dialogs: { pickFiles: (title, filters) => pickFiles(win, title, filters), pickFolder: (title) => pickFolder(win, title) },
    secrets: SECRET_FILES,
    diag,
    core,
    discord: { paced: discordApi, prompt: discordApi.prompt, humanPause: () => pace.humanPause(), posting },
    emojiIndex,
    mediaDir: media.media,
    sync,
    downloader,
    media: { fetchImageTo: (url, path) => fetchImageTo(mediaSessions, url, path), fetchVideoTo: (url, path) => fetchVideoTo(mediaSessions, url, path) },
    liveLabels: { provide: (id, fn) => labelProviders.provide(id, fn), changed: () => liveLabels.changed() },
    states,
    phone,
    pages,
    tailnet: new TailnetServe(runTailscale, profilePath(TAILNET_RECORDS_FILE), diag, UNRECORDED_TAILNET),
    publish,
  });
  registerRuleHandlers(win);
  registerMediaHandlers(media.attachments);

  app.on('window-all-closed', () => {
    discordSession.flushStorageData();
    // Main sides' switch-governed resources (a phone transport's server) stop; external config they made stays.
    void mainPlugins.stop();
    core.dispose();
    app.quit();
  });
});
