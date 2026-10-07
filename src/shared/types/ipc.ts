// Process plumbing: events pushed to the renderer, core request/response envelopes, IPC channel names.
import type { CoreMethod, CoreMethods } from '../contract';
import type { RendererApi } from '../rendererApi';
import type { DesktopState } from '../desktop';
import type { JevSpend } from '../jevSpend';
import type { ReadStateCount } from './archive';
import type { StorageMovePhase } from './storage';

/** What the Archive does with a message it shows for another window: open the composer on it (reply) or edit it in place. */
export const COMPOSE_INTENTS = ['reply', 'edit'] as const;
export type ComposeIntent = (typeof COMPOSE_INTENTS)[number];
export const isComposeIntent = (v: unknown): v is ComposeIntent => (COMPOSE_INTENTS as readonly unknown[]).includes(v);

/** Pushed to the renderer; the renderer never polls. */
export type AppEvent =
  | { type: 'archive-changed'; channelIds: string[]; /** Names or their styling (members, roles) changed: views re-read the names they show. */ namesChanged?: true; /** The servers whose names changed; absent when any server's may have. */ nameGuildIds?: string[] }
  | { type: 'sync-progress'; channelId: string; phase: 'catch-up' | 'backfill' | 'reverify' | 'idle' | 'paused' | 'error'; fetched: number; message?: string }
  /** `optedIn`: a channel now archived, which main syncs; main-only (sharedEvent drops it). */
  | { type: 'opt-in-changed'; optedIn?: string }
  /** A DM's newest message id rose; the directory patches that row instead of re-reading (list changes are archive-changed ''). */
  | { type: 'dm-activity'; channelId: string; lastMessageId: string }
  /** Discord's read states changed for these visible channels: the directory patches their rows (READY's are archive-changed ''). */
  | { type: 'read-states-changed'; states: ReadStateCount[] }
  /** Privacy mode or a private mark changed: every view re-reads what it shows. */
  | { type: 'privacy-changed' }
  /** Core's status (encryption) changed outside archive traffic: windows and the phone re-read it. */
  | { type: 'status-changed' }
  /** The live Discord client now shows this channel; the Archive follows it when opened. */
  | { type: 'live-channel'; guildId: string; channelId: string }
  /** Main asks its window to reveal a panel named by a notification. */
  | { type: 'open-panel'; panelId: string }
  /** Main asks the renderer to show a message (e.g. a clicked notification). Sent to the main window only (panel windows hand their message clicks to it). */
  | { type: 'open-message'; channelId: string; messageId?: string; compose?: ComposeIntent }
  /** Moving the archive to another folder (Settings → Archive); the app restarts when it's done. */
  | { type: 'storage-move'; phase: StorageMovePhase; doneBytes: number; totalBytes: number; message?: string }
  | { type: 'plugins-changed' }
  /** Rules or their runs changed. */
  | { type: 'rules-changed' }
  /** Message labels changed; null refreshes every loaded message. */
  | { type: 'message-labels-changed'; messageIds: string[] | null }
  /** A setting was written (by any window); every window's copy follows. */
  | { type: 'setting-changed'; key: string; value: unknown }
  /** Jev answered requests; the spend after them. */
  | { type: 'jev-spend'; spend: JevSpend }
  /** A bundled plugin's core event (channels.emit); main hands it to exactly the audiences its contract declares. */
  | { type: 'plugin-event'; pluginId: string; name: string; payload: unknown }
  /** Plugins' notes under these messages' attachments changed (a transcript's progress): open views re-read them. */
  | { type: 'attachment-notes-changed'; messageIds: string[] }
  /** Settings → Desktop's state changed (a setting, sign-in start, the hotkey, an update). Main window only. */
  | { type: 'desktop-changed'; state: DesktopState }
  /** A plugin asked for a desktop notification (main shows it). */
  /** Main learned who the signed-in Discord user is (at start and on a new sign-in). */
  | { type: 'self-changed'; userId: string }
  /** A channel's read mark moved to a message the owner saw: main marks it read on Discord, every surface re-reads counts. */
  | { type: 'channel-read'; channelId: string; messageId: string }
  /** Typing events refresh periodically until messages arrive. Optional name carries nickname/display name; verb carries custom typing wording. */
  | { type: 'typing'; channelId: string; userId: string; name?: string; verb?: string }
  | { type: 'plugin-notify'; pluginId: string; title: string; body: string; channelId?: string; messageId?: string };

/** `e` as windows and the phone get it: main's own work order (the channel to sync) stays in main, so no hidden DM shows. */
export const sharedEvent = (e: AppEvent): AppEvent => (e.type === 'opt-in-changed' && e.optedIn !== undefined ? { type: 'opt-in-changed' } : e);

/** Core → main unsolicited message carrying an AppEvent. */
export interface CoreEventMessage {
  kind: 'event';
  event: AppEvent;
}

export interface CoreRequest<M extends CoreMethod = CoreMethod> {
  id: number;
  method: M;
  params: Parameters<CoreMethods[M]>;
}

export type CoreResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** Where bundled plugins keep their data: `root`/<plugin id>, or a legacy folder main couldn't move this run. */
export interface PluginDataDirs {
  root: string;
  unmoved: Record<string, string>;
}

export interface CoreInit {
  kind: 'init';
  /** Directory holding the archive database and media (see main/storageLocation.ts). */
  archiveDir: string;
  /** Directory of plugin folders (docs/plugins.md). */
  pluginsDir: string;
  /** Bundled plugins' data folders (app profile, not archive data). */
  pluginData: PluginDataDirs;
  /** Database key when the archive is encrypted (Settings → Archive); null otherwise. */
  key: string | null;
}

/** Where the renderer wants the live Discord view drawn, in window CSS pixels. */
export interface DiscordSlot {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Session health of the embedded Discord client, as seen by ChattyPop. */
export interface DiscordProbe {
  loggedIn: boolean;
  capturedAt: number | null;
  /** History page limits observed from client requests. */
  observedLimits: number[];
  username: string | null;
  guildCount: number | null;
  error: string | null;
  /** Passive gateway capture. */
  gateway: {
    compress: string | null;
    frames: number;
    decodeErrors: number;
    events: Record<string, number>;
    recentMessageEvents: { t: string; channelId: string; messageId: string; edited: boolean }[];
  };
}

export const APP_EVENT_CHANNEL = 'app:event';

/** Renderer invoke channels map to RendererApi groups. Preload forwarders and type checks require every method to have a channel. */
export const MAIN_INVOKE = {
  openRouter: {
    signIn: 'openrouter:sign-in',
    addKey: 'openrouter:add-key',
    updateKey: 'openrouter:update-key',
    removeKey: 'openrouter:remove-key',
  },
  typeSafe: {
    setKey: 'typesafe:set-key',
    removeKey: 'typesafe:remove-key',
  },
  discord: {
    probe: 'discord:probe',
    /** The server and channel the live client shows now, for windows that open after it navigated. */
    shownChannel: 'discord:shown-channel',
    refreshDirectory: 'discord:directory',
    setOptIn: 'discord:opt-in',
    suggestChannels: 'discord:suggest-channels',
    /** Posts what the owner wrote in the Archive composer (OwnerMessage). */
    send: 'discord:send',
    uploadLimit: 'discord:upload-limit',
    prepareUploads: 'discord:prepare-uploads',
    uploadChunk: 'discord:upload-chunk',
    finishUpload: 'discord:finish-upload',
    /** Edits one of the owner's messages (OwnerEdit). */
    edit: 'discord:edit',
    /** Deletes one of the owner's messages (OwnerMessageRef). */
    deleteMessage: 'discord:delete-message',
    /** Forwards a message to another channel (OwnerForward). */
    forward: 'discord:forward',
    /** Adds or takes back the owner's reaction (OwnerReaction). */
    react: 'discord:react',
    gifs: 'discord:gifs',
    /** The owner's custom theme from their Discord settings (Settings → Appearance import). */
    customTheme: 'discord:custom-theme',
    /** Writes Chat settings to the owner's Discord account (SyncedChatSettings). */
    setChatSettings: 'discord:set-chat-settings',
    expressions: 'discord:expressions',
    commands: 'discord:commands',
    runCommand: 'discord:run-command',
    autocomplete: 'discord:autocomplete',
    useComponent: 'discord:use-component',
    submitModal: 'discord:submit-modal',
    roles: 'discord:roles',
    requestMembers: 'discord:request-members',
    createThread: 'discord:create-thread',
    sendDirect: 'discord:send-direct',
    profile: 'discord:profile',
    mutualFriends: 'discord:mutual-friends',
    reactors: 'discord:reactors',
    friends: 'discord:friends',
    startDm: 'discord:start-dm',
    dmWith: 'discord:dm-with',
    addToDm: 'discord:add-to-dm',
    closeDm: 'discord:close-dm',
    renameDm: 'discord:rename-dm',
    muteDm: 'discord:mute-dm',
  },
  storage: {
    info: 'storage:info',
    move: 'storage:move',
    deletePrevious: 'storage:delete-previous',
    setEncrypted: 'storage:encrypt',
  },
  /** A window's calls into plugins (RendererApi.plugins); main stamps their origin. */
  plugins: {
    callCore: 'plugins:call-core',
    callMain: 'plugins:call-main',
  },
  rules: {
    pickFile: 'rules:pick-file',
  },
  media: {
    saveAttachment: 'media:save-attachment',
  },
  desktop: {
    state: 'desktop:state',
    set: 'desktop:set',
    setOpenAtLogin: 'desktop:open-at-login',
    setBadge: 'desktop:badge',
    checkForUpdate: 'desktop:check-update',
    installUpdate: 'desktop:install-update',
  },
  marketplace: {
    state: 'marketplace:state',
    add: 'marketplace:add',
    remove: 'marketplace:remove',
    setToken: 'marketplace:set-token',
    refresh: 'marketplace:refresh',
    install: 'marketplace:install',
    installLocal: 'marketplace:install-local',
    uninstall: 'marketplace:uninstall',
    cancel: 'marketplace:cancel',
  },
} as const satisfies { [G in keyof RendererApi]?: { [K in keyof RendererApi[G]]?: string } };
export type MainInvokeGroup = keyof typeof MAIN_INVOKE;

export const PLUGINS_OPEN_FOLDER_CHANNEL = 'plugins:open-folder';
/** Renderer → main: restart the app through its graceful close. */
export const APP_RESTART_CHANNEL = 'app:restart';
/** Renderer → main: open (or focus) a panel in its own window. */
export const PANEL_WINDOW_CHANNEL = 'window:open-panel';
/** Panel window → main: show a message (or channel) in the main window's Archive. */
export const SHOW_IN_MAIN_CHANNEL = 'window:show-in-main';

/** ipcMain channel carrying renderer → core calls. */
export const CORE_INVOKE_CHANNEL = 'core:invoke';
/** ipcRenderer.send channel carrying the Discord view slot. */
export const DISCORD_SLOT_CHANNEL = 'discord:slot';
/** ipcRenderer.send channel carrying the Discord sidebar choices. */
export const DISCORD_SIDEBAR_CHANNEL = 'discord:sidebar';
/** Renderer → main: show a channel in the live client (guild id or "@me", channel id). */
export const DISCORD_OPEN_CHANNEL = 'discord:open-channel';

/** Gateway dispatches the archive consumes; main forwards only these to core. */
export const ARCHIVED_GATEWAY_EVENTS = [
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_LIST_SYNC',
  'GUILD_MEMBERS_CHUNK',
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
  'GUILD_MEMBER_LIST_UPDATE',
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
  // DMs and group DMs (types 1 and 3); server channels' copies are ignored.
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'CHANNEL_RECIPIENT_ADD',
  'CHANNEL_RECIPIENT_REMOVE',
] as const;
export type ArchivedGatewayEvent = (typeof ARCHIVED_GATEWAY_EVENTS)[number];
const archivedGatewayEvents = new Set<string>(ARCHIVED_GATEWAY_EVENTS);
export const isArchivedGatewayEvent = (t: string): t is ArchivedGatewayEvent => archivedGatewayEvents.has(t);
