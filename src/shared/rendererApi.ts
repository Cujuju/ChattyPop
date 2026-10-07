// The renderer's API (`window.chattypop`) and the core methods it may call; re-exported by './contract'.
import type { PluginCallResult } from './pluginCall';
import type { CoreMethod, CoreMethods, CoreResult } from './contract';
import type { AutocompleteRequest, CommandChoice, CommandIndex, CommandRun, ComponentUse, DirectMessage, GuildRole, InteractionOutcome, ModalSubmit, NewThread } from './commands';
import type { ExpressionCatalog, Gif, OwnerEdit, OwnerForward, OwnerMessage, OwnerMessageRef, OwnerReaction } from './compose';
import type { OpenRouterKeyRouting } from './openrouter';
import type { RuleFileFormat } from './ruleKinds/host';
import type { DesktopSettings, DesktopState } from './desktop';
import type { CustomTheme, DiscordSidebar } from './settings';
import type { SyncedChatSettings } from './chatSettings';
import type { AppEvent, ComposeIntent, DiscordProbe, DiscordSlot } from './types/ipc';
import type { ChannelSuggestion, StorageInfo } from './types/storage';
import type { ArchiveEmoji } from './types/archive';
import type { DiscordProfile, MutualFriends, ReactionUsers } from './types/discordProfile';
import type { DmOutcome, Friend, MuteWindow } from './dms';
import type { UnreadTotals } from './unread';
import type { MarketplaceApi } from './marketplace';

/** Surface exposed to the renderer as `window.chattypop`. */
export interface RendererApi {
  core: { [M in RendererCoreMethod]: (...params: Parameters<CoreMethods[M]>) => Promise<CoreResult<M>> };
  openRouter: {
    /** Opens OpenRouter sign-in in the browser; resolves once the new key is stored (any model if no key pays for that yet). */
    signIn(): Promise<void>;
    /** Checks a pasted API key with OpenRouter, then stores it with its routing. */
    addKey(key: string, routing: OpenRouterKeyRouting): Promise<void>;
    updateKey(id: string, routing: OpenRouterKeyRouting): Promise<void>;
    removeKey(id: string): Promise<void>;
  };
  /** The TypeSafe key for connecting to Jev directly. */
  typeSafe: {
    /** Checks a pasted key with TypeSafe, then stores it encrypted, replacing any earlier one. */
    setKey(key: string): Promise<void>;
    removeKey(): Promise<void>;
  };
  discord: {
    setSlot(slot: DiscordSlot): void;
    /** Hides the live client's server column and/or collapses its channel column. */
    setSidebar(sidebar: DiscordSidebar): void;
    /** Shows a channel in the live client (guild id, or "@me" for DMs). */
    openChannel(guildId: string, channelId: string): void;
    probe(): Promise<DiscordProbe>;
    /** Live server/channel, or null before display. Changes emit live-channel. */
    shownChannel(): Promise<{ guildId: string; channelId: string } | null>;
    /** Fetches the server list, or one server's channels, into the archive directory. */
    refreshDirectory(guildId?: string): Promise<void>;
    setOptIn(channelId: string, on: boolean): Promise<void>;
    /** Samples this server's unarchived channels and asks Jev which match the owner's rules. */
    suggestChannels(guildId: string): Promise<ChannelSuggestion[]>;
    /** Posts a message as the owner (text, reply, files, sticker or GIF); rejects with Discord's reason. */
    send(m: OwnerMessage): Promise<void>;
    /** Replaces the text of one of the owner's messages; rejects with Discord's reason. */
    edit(e: OwnerEdit): Promise<void>;
    /** Deletes one of the owner's messages from Discord (the archive keeps its copy); rejects with Discord's reason. */
    deleteMessage(m: OwnerMessageRef): Promise<void>;
    /** Forwards a message to another channel; rejects with Discord's reason. */
    forward(f: OwnerForward): Promise<void>;
    /** Adds or takes back the owner's reaction; resolves once the archive shows it. Rejects with Discord's reason. */
    react(r: OwnerReaction): Promise<void>;
    /** GIFs matching the query, or trending GIFs for an empty one. */
    gifs(query: string): Promise<Gif[]>;
    /** The owner's custom theme as set in Discord; rejects when Discord has none. */
    customTheme(): Promise<CustomTheme>;
    /** Writes Chat settings to the owner's Discord account; resolves once the archive's copy of the account's settings shows them. */
    setChatSettings(change: Partial<SyncedChatSettings>): Promise<void>;
    /** Loads guild emoji/stickers, standard packs and plan perks; fetches guildId when absent from gateway. */
    expressions(guildId: string): Promise<ExpressionCatalog>;
    /** The slash commands usable in a channel (guildId null for a DM). */
    commands(channelId: string, guildId: string | null): Promise<CommandIndex>;
    /** Runs a slash command; resolves once the app acknowledged it (its reply arrives as a message), or with its form. */
    runCommand(run: CommandRun): Promise<InteractionOutcome>;
    /** The app's suggestions for the option being typed; rejects when it doesn't answer in time. */
    autocomplete(req: AutocompleteRequest): Promise<CommandChoice[]>;
    /** Presses a button or picks from a menu on a bot's message. */
    useComponent(use: ComponentUse): Promise<InteractionOutcome>;
    /** Sends a bot's filled-in form. */
    submitModal(submit: ModalSubmit): Promise<InteractionOutcome>;
    /** A server's roles, highest first. */
    roles(guildId: string): Promise<GuildRole[]>;
    /** Asks Discord for a server's members whose names start with `query`, as its `@` autocomplete does; they reach the archive as members change. */
    requestMembers(guildId: string, query: string): Promise<void>;
    /** Starts a public thread in a text channel, with its first message when given (Discord's /thread). */
    createThread(t: NewThread): Promise<void>;
    /** Sends a direct message to one person (Discord's /msg). */
    sendDirect(m: DirectMessage): Promise<void>;
    /** A person's profile fetched from Discord now, as seen in guildId (null outside a server); also cached. */
    profile(userId: string, guildId: string | null): Promise<DiscordProfile>;
    /** Friends the owner shares with them, fetched now; also cached. */
    mutualFriends(userId: string): Promise<MutualFriends>;
    /** The first people who reacted with moji, fetched now; count is the reaction's count shown. Also cached. */
    reactors(channelId: string, messageId: string, emoji: ArchiveEmoji, count: number): Promise<ReactionUsers>;
    /** The owner's friends whose names are known, by name (the New message picker). */
    friends(): Promise<Friend[]>;
    /** Starts one-person/group DMs; existing open DMs send nothing. Applies archive choices to newly created channels and resolves after core storage; Discord errors reject. */
    startDm(recipients: string[], archive: boolean): Promise<DmOutcome>;
    /** The owner's DM with one person, from their profile: the open one, else a new one; its channel id once core holds it. */
    dmWith(userId: string): Promise<string>;
    /**
     * Adds friends to a DM or group; a DM becomes a new group (`created`), which `archive` applies to. Rejects with
     * Discord's reason.
     */
    addToDm(channelId: string, userIds: string[], archive: boolean): Promise<DmOutcome>;
    /** Closes a DM or leaves a group; `quietly` leaves without telling its members. */
    closeDm(channelId: string, quietly: boolean): Promise<void>;
    renameDm(channelId: string, name: string): Promise<void>;
    /** Mutes a DM on Discord for one of its lengths, or unmutes it (null). */
    muteDm(channelId: string, window: MuteWindow | null): Promise<void>;
  };
  storage: {
    info(): Promise<StorageInfo>;
    /** Asks for a folder, then copies, verifies and switches to it, restarting the app. Resolves early if cancelled. */
    move(): Promise<void>;
    /** Deletes the previous copy after the user confirms in a system dialog. */
    deletePrevious(): Promise<void>;
    /** Encrypts or decrypts the archive database (the key is kept by Windows for this account). */
    setEncrypted(on: boolean): Promise<void>;
  };
  /** Calls into plugins; main stamps them as this window's. Arguments and results must be cloneable. */
  plugins: {
    /** A plugin's core call: a folder plugin's rpc.handle, or a bundled plugin's member for windows. */
    callCore(pluginId: string, name: string, args: unknown[]): Promise<PluginCallResult>;
    /** A bundled plugin's main call. */
    callMain(pluginId: string, name: string, args: unknown[]): Promise<PluginCallResult>;
  };
  /** Settings → Plugins → Marketplaces: installable plugins from GitHub repos. */
  marketplace: MarketplaceApi;
  rules: {
    /** Asks for a file a rule's file action appends to (an existing one, or a new one); null when cancelled. */
    pickFile(format: RuleFileFormat): Promise<string | null>;
  };
  media: {
    /** Asks where to save an archived attachment (its own name offered), then copies it there. Resolves when done or cancelled. */
    saveAttachment(sha256: string, filename: string): Promise<void>;
  };
  /** Desktop settings; changes emit desktop-changed to main window. */
  desktop: {
    state(): Promise<DesktopState>;
    set(patch: Partial<DesktopSettings>): Promise<void>;
    /** Has Windows start ChattyPop at sign-in, or stop; rejects where it can't (a dev run). */
    setOpenAtLogin(on: boolean): Promise<void>;
    /** The main window's unread totals per kind, for the taskbar and tray indicators. */
    setBadge(unread: UnreadTotals): Promise<void>;
    checkForUpdate(): Promise<void>;
    /** Closes gracefully (keeping the Discord login), installs the downloaded update and starts again. */
    installUpdate(): Promise<void>;
  };
  /** Opens the plugins folder in the file manager. */
  openPluginsFolder(): Promise<void>;
  /** Closes the app gracefully (keeping the Discord login) and starts it again. */
  restartApp(): Promise<void>;
  /** Opens a panel in its own window, or focuses it if already open. */
  openPanelWindow(panelId: string): Promise<void>;
  /** From a panel window: brings the main window up showing this message (or channel) in the Archive; `compose` replies to or edits it there. */
  showInMainWindow(channelId: string, messageId?: string, opts?: { compose: ComposeIntent }): void;
  /** Subscribes to pushed app events; returns an unsubscribe function. */
  onEvent(listener: (e: AppEvent) => void): () => void;
}

/** Core methods the renderer may call directly. Ingest/sync methods stay main-only. */
export const RENDERER_CORE_METHODS = [
  'status',
  'getSetting',
  'setSetting',
  'directory',
  'channelUnread',
  'channelUnreadSnapshot',
  'archivedBots',
  'markChannelRead',
  'markDmRead',
  'syncState',
  'aiStatus',
  'aiPlanUsage',
  'aiUsageSince',
  'jevStatus',
  'jevSpend',
  'jevCheckMessage',
  'jevAskRange',
  'jevQueryOverrides',
  'setJevQuery',
  'jevRerunCount',
  'jevRerun',
  'openRouterKeys',
  'openRouterBalances',
  'messagePage',
  'messageById',
  'searchMessages',
  'personProfile',
  'discordProfile',
  'mutualFriends',
  'reactors',
  'findPeople',
  'peopleByIds',
  'personNames',
  'mentionCandidates',
  'ownerModerates',
  'conversation',
  'ownEmoji',
  'ownReactions',
  'ownCommands',
  'rankSearch',
  'rules',
  'createRule',
  'updateRule',
  'deleteRule',
  'ruleRuns',
  'patternPreview',
  'lastSeenAt',
  'selfId',
  'setChannelPolicy',
  'setGuildHideInPrivacy',
  'plugins',
  'setPluginEnabled',
  'reloadPlugins',
  'absentPlugins',
  'runPluginCommand',
] as const satisfies readonly CoreMethod[];
export type RendererCoreMethod = (typeof RENDERER_CORE_METHODS)[number];
