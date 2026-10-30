// Electron wiring for the archive, Discord view and plugins. Main's boot entry (index.ts) imports it once what must
// precede 'ready' is done and installed plugins are decided.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, app, ipcMain, session, shell } from 'electron';
import { callMain, handleMain } from './ipc/mainCalls';
import {
  CORE_INVOKE_CHANNEL,
  MAIN_INVOKE,
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
import { startupArchiveKeys } from './archiveKey';
import { CoreClient } from './coreClient';
import { routeCoreEvents } from './coreEvents';
import { registerShownChannelHandlers } from './shownChannel';
import { diag } from './diagnostics';
import { pickFiles, pickFolder } from './dialogs';
import { SECRET_FILES } from './secretFile';
import { DiscordApi } from './discord/api';
import { HeaderCapture } from './discord/capture';
import { ClientShapes, carried, gatewayRoute, routeTemplate } from './discord/clientShapes';
import { GatewayDirectory } from './discord/directory';
import { GuildEmojiIndex } from './discord/guildEmojis';
import { ReadStates } from './discord/readStates';
import { watchPrivateChannels } from './discord/privateChannels';
import { watchGuildOrder } from './discord/guildOrder';
import { AccountChatSettings } from './discord/chatSettings';
import { LiveLabelProviders } from './discord/labelProviders';
import { LiveLabels } from './discord/liveLabels';
import { pageAsset } from './discord/pageAssets';
import { discordFontUrl } from './discord/pageFonts';
import { gatewayAccessFacts } from './discord/access';
import { OwnerSession } from './discord/ownerSession';
import { gatewayArchivePayload } from './discord/gatewayPeople';
import { gatewayGuildRoles } from './discord/roles';
import { TypingEvents } from './discord/typing';
import { LoginRelay, followSession } from './discord/loginRelay';
import { LiveUpdates } from './discord/liveUpdates';
import { normalizeRelayInput } from '@shared/discordLogin';
import { DISCORD_PARTITION, type DiscordView } from './discordView';
import { registerDiscordHandlers } from './ipc/discord';
import { registerKeyHandlers } from './ipc/keys';
import { loadOpenRouterKeys } from './openrouterKeys';
import { loadTypeSafeKey } from './typesafeKey';
import { loadProviderKeys, loadProxyKey } from './providerKeys';
import { registerRuleHandlers } from './ipc/rules';
import { registerMediaHandlers } from './ipc/media';
import { registerAttachmentStoreHandlers } from './ipc/attachmentStore';
import { htmlToPdf } from './pdf';
import { registerStorageHandlers } from './ipc/storage';
import { restartApp } from './restart';
import { registerMarketplaceHandlers } from './marketplace/ipc';
import { buildFromSource } from './marketplace/sourceBuild';
import { Desktop } from './desktop';
import { installAppMenu } from './appMenu';
import { appIconPath, createMainWindow, loadRenderer, rendererWindowOptions } from './mainWindow';
import { IS_MAC } from './platform';
import { launchMode } from './launchMode';
import { pairOnScreen, printPairing } from './serverMode';
import { startSplash } from './splash';
import { AttachmentDownloader, freshAttachmentUrl } from './media/attachmentDownloader';
import { backfillAttachmentThumbs, keepAttachmentThumb } from './media/attachmentThumbs';
import { mediaDirs, removeAbandonedPartials, removeLegacyCaches } from './media/mediaDirs';
import { handleMediaScheme, mediaHandler } from './media/mediaProtocol';
import { attachmentPoster, fetchImageTo, fetchVideoTo, posterKept, type PosterSource } from './media/thumbStore';
import { PanelWindows } from './panelWindows';
import { registerPageErrors } from './pageErrors';
import { PhoneHub, type DiscordCalls } from './phone/hub';
import bundledMain, { failed as failedMain } from 'virtual:bundled-plugins/main';
import { startMainPlugins } from './plugins/bundled';
import { ActionSpacer } from './plugins/discordContext';
import { pluginDataDirs } from './plugins/dataDir';
import { installedFiles } from './plugins/installedFiles';
import { installedStart } from './plugins/installed/runtime';
import { rendererPages } from './plugins/pages';
import { postingGate } from './plugins/posting';
import { PluginStates } from './plugins/states';
import { handleInstalledScheme, handlePluginScheme } from './pluginProtocol';
import { profilePath, storageConfig } from './storageLocation';
import { type Publication, TailnetServe, runTailscale } from './tailnet';
import { followArchiveChanges } from './sync/depthChange';
import { Pace } from './sync/pace';
import { SyncService } from './sync/syncService';
import { shutdownSequence } from './shutdown';
import { raiseWindow } from './windowState';

/** In-memory session for third-party media (X images): no Discord cookies, nothing persisted. */
const WEB_MEDIA_PARTITION = 'web-media';

const APP_USER_MODEL_ID = 'com.cujuju.chattypop';
/** Plugin folders live in the app profile: they are code and settings, not archive data. */
const PLUGINS_DIR = 'plugins';
/** Profile file recording the Tailscale Serve config plugins set, so the host can remove it without them. */
const TAILNET_RECORDS_FILE = 'tailnet-serve.json';
/** Field names of the live client's own requests and gateway sends, kept across runs (clientShapes.ts). */
const CLIENT_SHAPES_FILE = 'discord-client-shapes.json';
/** Serve config the Companion set before the record file existed (frozen values), so a profile without one can remove it. */
const UNRECORDED_TAILNET: readonly Publication[] = [{ pluginId: 'companion', httpsPort: 8443, target: 'http://127.0.0.1:47831' }];
/** out/main: this module is its own build entry (electron.vite.config.ts), so it sits beside core.js. */
const here = import.meta.dirname;
/** out/renderer, next to out/main where this module is bundled: the built windows and plugin pages. */
const RENDERER_DIR = join(here, '../renderer');
const rendererCoreMethods = new Set<string>(RENDERER_CORE_METHODS);
/** The splash step each core init milestone ends. */
const SPLASH_STEP_OF_CORE: Record<CoreInitStep, SplashPhaseId> = { loaded: 'core', database: 'database' };
/** This run's mode (index.ts starts a client elsewhere): the app, or a server for other machines (--server). */
const mode = launchMode(process.argv, process.env);
const serverMode = mode.kind === 'server';

// Stays synchronous (no await): gateway tap listeners must attach in the window's creation tick, or READY is missed.
void app.whenReady().then(() => {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // A dev run is Electron's own bundle, so the dock shows Electron's icon unless told; a packaged app carries its own.
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(appIconPath());
  installAppMenu();
  const location = storageConfig();
  const dataDir = location.archiveDir;
  mkdirSync(dataDir, { recursive: true });
  const pluginsDir = profilePath(PLUGINS_DIR);
  mkdirSync(pluginsDir, { recursive: true });
  const keys = startupArchiveKeys(location, (event, err) => diag(event, { message: errorMessage(err) }));
  const core = new CoreClient(join(here, 'core.js'), {
    archiveDir: dataDir, pluginsDir, pluginData: pluginDataDirs(), keys,
    openRouterKeys: loadOpenRouterKeys(), typeSafeKey: loadTypeSafeKey(), providerApiKeys: loadProviderKeys(SECRET_FILES), proxyKey: loadProxyKey(SECRET_FILES),
  }, diag);
  registerKeyHandlers(core);

  // Capture must be installed before the Discord view loads, or its first API requests are missed.
  const discordSession = session.fromPartition(DISCORD_PARTITION);
  const capture = new HeaderCapture(discordSession);
  // What the client itself sends, per route; ours are checked against it and differences noted in diagnostics.
  const shapes = new ClientShapes(
    profilePath(CLIENT_SHAPES_FILE),
    (route, difference) => diag('discord-shape-mismatch', { route, ...difference }),
    (message) => diag('client-shapes-save-failed', { message }),
  );
  capture.onClientRequest = (method, url, body) => {
    const u = new URL(url);
    shapes.observe(routeTemplate(method, u), carried(u, body));
  };
  const pace = new Pace(core);
  const currentPace = (): ReturnType<Pace['current']> => pace.current();
  // The API runs inside the Discord page, which exists once the window is created below.
  let discordRef: DiscordView | undefined;
  const discordApi = new DiscordApi(() => discordRef, capture, currentPace, shapes);
  const media = mediaDirs(dataDir);
  removeLegacyCaches(media);
  removeAbandonedPartials(media);
  const mediaSessions = { discord: discordSession, web: session.fromPartition(WEB_MEDIA_PARTITION) };
  const posterOf = (a: PendingAttachment): PosterSource => ({ stored: a.url, fresh: () => freshAttachmentUrl(discordApi, a) });
  const posterSource = async (id: string): Promise<PosterSource | null> => {
    const a = await core.call('attachmentSource', id);
    return a ? posterOf(a) : null;
  };
  const pageAssets = { fontUrl: (family: string) => discordFontUrl(discordRef, family), load: (url: string, family?: string) => pageAsset(discordRef, url, family) };
  const serveMedia = mediaHandler(media, mediaSessions, pageAssets, posterSource);
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
    (name) => keepAttachmentThumb(media.attachments, media.previews, name),
  );

  ipcMain.handle(CORE_INVOKE_CHANNEL, (_e, method: string, params: unknown[]) => {
    if (!rendererCoreMethods.has(method)) throw new Error(`core method not available to renderer: ${method}`);
    return core.call(method as CoreMethod, ...(params as []));
  });

  const desktop = new Desktop(serverMode);
  const { win, discord } = createMainWindow(desktop);
  // A server is a menu-bar app on macOS: its dock icon shows only while its window does.
  if (serverMode && IS_MAC) {
    app.dock?.hide();
    win.on('show', () => void app.dock?.show());
    win.on('hide', () => app.dock?.hide());
  }
  const splash = startSplash(win, desktop.startHidden);
  core.on('init-step', (step) => splash.finish(SPLASH_STEP_OF_CORE[step]));
  // Core answers only once its init is done, so its first answer marks the archive open.
  void core.call('selfId').then(() => splash.finish('archive'), () => undefined);
  win.webContents.once('did-finish-load', () => {
    splash.finish('interface');
    // After the window is up, so startup doesn't share the thumbnailer.
    void backfillAttachmentThumbs(media.attachments, media.previews, () => archiveMoving);
  });
  app.on('second-instance', () => raiseWindow(win));
  discordRef = discord;
  // The signed-in account: built before every other gateway reader, which reads the account from it.
  const ownerSession = new OwnerSession(discord.tap, capture);
  const emojiIndex = new GuildEmojiIndex(discord.tap);
  // Discord's unread mention counts for the sidebar; a channel read in ChattyPop is acknowledged on Discord.
  const readStates = new ReadStates(
    discord.tap,
    ownerSession,
    discordApi,
    (counts, scope) => core.tell('putReadStates', counts, scope),
    diag,
  );
  core.on('event', (e) => {
    if (e.type === 'channel-read') readStates.ack(e.channelId, e.messageId);
  });
  // The signed-in account and its DM list, from READY: no request.
  watchPrivateChannels(discord.tap, ownerSession, core, diag);
  // Servers and their channels, from READY and its updates: no request.
  const directory = new GatewayDirectory(discord.tap);
  discord.tap.on('sent', ({ op, d }) => shapes.observe(gatewayRoute(op), carried(null, JSON.stringify(d ?? null))));
  // Servers in the owner's Discord sidebar order, from READY's settings and their updates.
  watchGuildOrder(discord.tap, (guildIds) => core.tell('putGuildOrder', guildIds), diag);
  // The account's Chat settings, from READY and their updates: every window and phone reads them from the archive.
  const chatSettings = new AccountChatSettings(discord.tap, discordApi.prompt, (settings) => core.call('setSetting', SETTINGS_KEYS.discordChat, settings), diag);
  const panelWindows = new PanelWindows(win, loadRenderer, rendererWindowOptions());
  registerPageErrors((sender) => {
    if (sender === win.webContents) return 'main';
    const id = panelWindows.panelId(sender);
    return id === undefined ? undefined : `panel:${id}`;
  });
  registerShownChannelHandlers(win, panelWindows);
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
  const { toRenderer, toMain, publish, notifications } = routeCoreEvents({ win, panelWindows, core, downloader, phone, desktopNotices: !serverMode });
  // A server's tray pairs a device in the transport's Settings section; --pair also prints a code to the terminal.
  const pair = (): void =>
    void pairOnScreen(() => phone.startPairing(), {
      raise: () => raiseWindow(win),
      openSettings: (section) => toMain({ type: 'open-settings', section }),
      tell: (text) => Notification.isSupported() && new Notification({ title: 'Pair a device', body: text }).show(),
    });
  desktop.attach(win, toRenderer, serverMode ? pair : undefined);
  if (mode.kind === 'server' && mode.printPairing) void printPairing(() => phone.startPairing(), (text) => console.log(text));
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

  // Signing the Discord client in from a remote desktop; followSession (below) tells it whether the client is signed in.
  const relay = new LoginRelay({ win, view: discord, emit: toRenderer, diag });
  const { discord: discordChannels } = MAIN_INVOKE;
  handleMain(discordChannels.loginState, () => relay.state);
  handleMain(discordChannels.loginRelayState, () => relay.relayState);
  handleMain(discordChannels.loginStart, () => relay.start());
  // Whether the live client's gateway traffic reaches ChattyPop; Reconnect reloads the client for the tap to read anew.
  const liveUpdates = new LiveUpdates({ tap: discord.tap, signedIn: () => relay.state === 'signed-in', emit: toRenderer, diag });
  handleMain(discordChannels.liveUpdates, () => liveUpdates.state);
  handleMain(discordChannels.reconnect, async () => {
    liveUpdates.wait();
    // A failed load leaves the state waiting, so the warning returns once the grace passes.
    await discord.reconnect().catch((err: unknown) => diag('discord-reconnect-failed', { message: errorMessage(err) }));
  });
  handleMain(discordChannels.loginStop, () => relay.stop());
  handleMain(discordChannels.loginInput, (e) => {
    const input = normalizeRelayInput(e);
    if (!input) throw new Error('Not a pointer or key event.');
    return relay.input(input);
  });

  discord.onChannel = (guildId, channelId) => {
    toRenderer({ type: 'live-channel', guildId, channelId });
    liveLabels.showChannel(channelId);
  };
  const sync = new SyncService(discordApi, core, toRenderer, directory);
  // A channel archived (by the owner, or a DM by auto-archive) syncs its history.
  core.on('event', (e) => {
    if (e.type === 'opt-in-changed' && e.optedIn) sync.enqueue(e.optedIn);
    // Core announces every READY, once it knows the account: whose DMs sync keeps, and a gateway gap to catch up.
    if (e.type === 'self-changed') void sync.sessionReady();
  });
  followSession(relay, { page: discord, capture }, () => void sync.syncAll());
  sync.onSettled = () => core.tell('syncSettled');
  followArchiveChanges(core, sync);
  discord.tap.on('dispatch', ({ t, d, socketId }) => {
    if (isArchivedGatewayEvent(t)) core.tell('applyGatewayEvent', t, gatewayArchivePayload(t, d));
    const typing = typingEvents.read(t, d);
    if (typing) toRenderer(typing);
    for (const g of gatewayGuildRoles(t, d)) core.tell('replaceGuildRoles', g.guildId, g.roles);
    const access = gatewayAccessFacts(t, d, ownerSession.accountOf(socketId));
    if (access && (access.owners.length || access.overwrites.length || access.members.length)) core.tell('applyAccessFacts', access);
  });

  registerStorageHandlers({
    win,
    core,
    archiveDir: dataDir,
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
  discordCalls = registerDiscordHandlers({ attachments: downloader, win, core, sync, owner: discordApi.prompt, capture, session: ownerSession, discord, emojiIndex, readStates, posting, discordSession, chatSettings, directory, emit: toRenderer });
  const pages = rendererPages(RENDERER_DIR, process.env['ELECTRON_RENDERER_URL'] ?? null, installed);
  for (const { id, error } of failedMain) diag('installed-plugin-load-failed', { pluginId: id, message: error });
  const mainPlugins = startMainPlugins(bundledMain, {
    notifications,
    dialogs: { pickFiles: (title, filters) => pickFiles(win, title, filters), pickFolder: (title) => pickFolder(win, title) },
    secrets: SECRET_FILES,
    diag,
    core,
    discord: { paced: discordApi, prompt: discordApi.prompt, humanPause: () => pace.humanPause(), posting, spacer: new ActionSpacer(() => pace.automaticPauseMs()) },
    emojiIndex,
    mediaDir: media.media,
    sync,
    downloader,
    media: { fetchImageTo: (url, path) => fetchImageTo(mediaSessions, url, path), fetchVideoTo: (url, path) => fetchVideoTo(mediaSessions, url, path) },
    liveLabels: { provide: (id, fn) => labelProviders.provide(id, fn), changed: () => liveLabels.changed() },
    states,
    phone,
    pages,
    pdf: htmlToPdf,
    tailnet: new TailnetServe(runTailscale, profilePath(TAILNET_RECORDS_FILE), diag, UNRECORDED_TAILNET),
    publish,
  });
  registerRuleHandlers(win);
  registerMediaHandlers(media.attachments, { folderRecord: profilePath('attachment-export-folder.json'), previewsDir: media.previews });
  registerAttachmentStoreHandlers(media.attachments, core);

  const shutdown = shutdownSequence({
    flush: () => {
      discordSession.flushStorageData();
      shapes.flush();
    },
    // Main sides' switch-governed resources (a phone transport's server) stop; external config they made stays.
    stopPlugins: async () => { await downloader.dispose(); await mainPlugins.stop(); },
    disposeCore: () => core.dispose(),
    quit: () => app.quit(),
    diag,
  });
  app.on('window-all-closed', () => void shutdown.run());
  // A quit that skips window-all-closed (macOS Cmd+Q, an update's install) waits for the same sequence, which quits again.
  app.on('will-quit', (e) => {
    if (shutdown.done()) return;
    e.preventDefault();
    void shutdown.run();
  });
});
