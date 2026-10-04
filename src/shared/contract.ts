// Typed contracts between renderer ⇄ main ⇄ core (utilityProcess): the core and renderer APIs. Data types live in
// ./types and ./rendererApi and are re-exported here, so '@shared/contract' stays the one import.
import type { PluginCallResult } from './pluginCall';
import type { Audience } from './pluginChannels';
import type { UsedCommand } from './commands';
import type { OwnerReaction, UsedEmoji } from './compose';
import type { RawChannel, RawGuild, RawMessage, RawPrivateChannel, RawRole, RawThread, RawUser } from './discord';
import type { PrivateChannelFacts } from './dms';
import type { ContentKind } from './messageContent';
import type { OpenRouterKeyBalance, OpenRouterKeyEntry, OpenRouterKeyInfo } from './openrouter';
import type { PluginInfo, PluginRange } from './plugins';
import type { AbsentPlugin } from './pluginRestore';
import type { JevQueryOverrides, JevRerunRequest, JevRerunResult } from './jevQueries';
import type { ProviderId } from './settings';
import type { Rule, RuleInput, RuleRun } from './rules';
import type { CustomJevQuestion, JevQuestionSpec } from './jevQuestion';
import type { PatternPreview } from './keywordPattern';
import type { JevSpend } from './jevSpend';
import type {
  AppUsage,
  JevAskResult,
  JevCheckResult,
  JevRangeAsk,
  JevStatus,
  PlanUsageWindow,
  ProviderStatus,
} from './types/ai';
import type { ArchiveEmoji, ArchiveMessage, ChannelInfo, ConversationView, ChannelPolicy, CoreStatus, DirectoryGuild, IngestResult, MessagePageQuery, PendingAttachment, PendingEmoji, PrivacyScope, ReadStateCount, SearchHit, SyncState, UnreadMark } from './types/archive';
import type { MentionCandidate, PersonMatch, PersonName, PersonProfile } from './types/people';
import type { DiscordProfile, FetchedProfile, MutualFriends, ReactionUsers } from './types/discordProfile';
import type { ArchivedGatewayEvent } from './types/ipc';
import type { ChannelSample, ChannelSuggestion } from './types/storage';
import type { AccessFacts } from './permissions';

export * from './types/ai';
export * from './types/archive';
export * from './types/discordProfile';
export * from './types/ipc';
export * from './types/people';
export * from './types/storage';
export * from './rendererApi';

/** Resolved result type of a core method (sync or async). */
export type CoreResult<M extends CoreMethod> = Awaited<ReturnType<CoreMethods[M]>>;

/** Requests the core process answers. Keys are method names; results may be async. */
export interface CoreMethods {
  /** `refresh` re-lists models instead of using this session's cache. */
  aiStatus(refresh?: boolean): Promise<ProviderStatus[]>;
  aiPlanUsage(id: ProviderId): Promise<PlanUsageWindow[] | null>;
  /** ChattyPop's AI runs with a provider since a time, and their tokens (cache hits cost nothing and aren't counted). */
  aiUsageSince(id: ProviderId, sinceTs: number): AppUsage;
  /** Main hands core every OpenRouter key (with secrets) at startup and after each change. Never exposed to the renderer. */
  setOpenRouterKeys(keys: OpenRouterKeyEntry[]): void;
  /** Stored keys and their routing, without secrets. */
  openRouterKeys(): OpenRouterKeyInfo[];
  /** Each key's cap and spend from OpenRouter, by key id; `error` when it couldn't be read. */
  openRouterBalances(): Promise<Record<string, OpenRouterKeyBalance | { error: string }>>;
  /** Main hands core the TypeSafe key (direct Jev) at startup and after each change; null = none. Never exposed to the renderer. */
  setTypeSafeKey(key: string | null): void;
  jevStatus(): JevStatus;
  /** What Jev has cost, and the measured rate projections use. */
  jevSpend(): JevSpend;
  /** The standard checks, class labels, rules' own Jev questions and an optional ad-hoc question on one message. */
  jevCheckMessage(messageId: string, ask: JevQuestionSpec | null): Promise<JevCheckResult>;
  /** Custom Jev call: the owner's question about each of a channel's latest messages, ranked. */
  jevAskRange(ask: JevRangeAsk): Promise<JevAskResult>;
  /** The owner's edits to built-in Jev queries, by query id (Settings → Jev → Queries). */
  jevQueryOverrides(): JevQueryOverrides;
  /** Saves an edit to a built-in query (null = back to default); throws when the edit would break what the app reads. */
  setJevQuery(id: string, q: CustomJevQuestion | null): void;
  /** How many messages re-running a per-message query would ask about. */
  jevRerunCount(req: JevRerunRequest): number;
  /** Re-asks a per-message query about past messages and acts on the answers as for new ones. */
  jevRerun(req: JevRerunRequest): Promise<JevRerunResult>;

  /** Main tells core who the signed-in Discord user is, for "aimed at you" alerts and plugins (CoreContext identity.onSelf). */
  setSelf(user: RawUser): void;
  /** The signed-in Discord user's id; null until main has told core (later changes arrive as 'self-changed'). */
  selfId(): string | null;
  /** Main tells core the sync queue drained: the archive is current, so window actions may run. */
  syncSettled(): void;
  /** End of the previous app session: the default "since you were last here" boundary. */
  lastSeenAt(): number;
  status(): Promise<CoreStatus>;
  /** JSON value stored under `key`, or undefined. */
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  directory(): DirectoryGuild[];
  /** Whether notices about these channels are muted (Settings → Notifications): there is one and every one is, whatever privacy mode hides. */
  allMuted(channelIds: readonly string[]): boolean;
  /** Moves a channel's last-read mark to now (the Archive shows it; resets its new count); returns what was unread before. */
  markChannelViewed(channelId: string): UnreadMark | null;
  /** Marks a DM of the account signed in read, here and on Discord, up to Discord's newest message in it. */
  markDmRead(channelId: string): void;
  upsertGuilds(guilds: RawGuild[]): void;
  upsertChannels(guildId: string, channels: RawChannel[]): void;
  /**
   * Archives a channel or stops; a DM taken out is declined, so auto-archive skips it until it is archived again. A DM
   * archived must be the signed-in account's, and neither a message request nor a group left (throws).
   */
  setOptIn(channelId: string, on: boolean): void;
  /** Archived channels sync keeps current: a DM only when it is the signed-in account's and not a group left. */
  optedInChannels(): string[];
  /** The signed-in account's archived DMs sync keeps current: queued once READY names the account. */
  optedInDms(): string[];
  /** Whether sync still keeps a channel or thread current (as optedInChannels): checked before each page. */
  syncable(channelId: string): boolean;
  /** Stores threads of archived channels; returns those with messages left to sync. */
  upsertThreads(threads: RawThread[]): string[];
  /**
   * `selfId`'s DMs and group DMs as READY lists them, under the Direct messages group. Unless `partial`, that account's
   * DMs missing from the list are closed, never deleted.
   */
  replacePrivateChannels(selfId: string, channels: RawPrivateChannel[], partial: boolean): void;
  /** A DM or group DM of the signed-in account, as a write checks it; null for any other channel. */
  privateChannel(channelId: string): PrivateChannelFacts | null;
  /** The signed-in account's open one-to-one DM with a person; null when there is none. */
  dmWith(userId: string): string | null;
  /**
   * Discord's answer to a DM write made as `accountId`, merged as the gateway's copy of it is. Skipped (false) once
   * another account is signed in: the gateway owns it then. `archive`: the owner's choice for a conversation the write
   * made, applied in the same step, so no message for it can be auto-archived first.
   */
  applyDmWrite(accountId: string, t: Extract<ArchivedGatewayEvent, `CHANNEL_${string}`>, d: unknown, archive?: boolean): boolean;
  /** Every private channel stored, of any account: a DM write tells a channel it made from one held before. */
  privateChannelIds(): string[];
  /** Scores sampled channels against the owner's rules with Jev. */
  suggestChannels(samples: ChannelSample[]): Promise<ChannelSuggestion[]>;
  /** Imports DiscordChatExporter JSON files; their channels become archived. */
  channelInfo(channelId: string): ChannelInfo | null;
  setChannelPolicy(channelId: string, policy: ChannelPolicy): void;
  /** Marks a server private: hidden, with all its channels, while privacy mode is on. */
  setGuildHideInPrivacy(guildId: string, on: boolean): void;
  privacyScope(): PrivacyScope;
  /** Encrypts the database with `key`, or decrypts it (null). Main stores the key; core never persists it. */
  setEncryption(key: string | null): void;
  /** Checkpoints and closes the database so its files can be copied; every later call fails until restart. */
  closeArchive(): void;
  /** SQLite quick_check: 'ok', or the first problem found. */
  integrityCheck(): string;
  plugins(): PluginInfo[];
  setPluginEnabled(id: string, on: boolean): Promise<void>;
  /** Unloads every plugin and loads the plugins folder again. */
  reloadPlugins(): Promise<void>;
  /** Plugins whose data the archive and profile hold but that aren't loaded (first-start restore); once the plugins folder has loaded. */
  absentPlugins(): Promise<AbsentPlugin[]>;
  /** Runs a plugin command; resolves with the text it returned, if any. */
  runPluginCommand(pluginId: string, commandId: string, range: PluginRange): Promise<string | null>;
  /**
   * A call into a plugin's core side. `origin` is stamped by the transport it came through (main's window IPC, the
   * companion server, main plugins), never by the caller; core answers only the audiences the plugin declares.
   */
  pluginCall(origin: Audience, pluginId: string, name: string, args: unknown[]): Promise<PluginCallResult>;
  ingestMessages(messages: RawMessage[]): IngestResult;
  /** A gateway dispatch observed by the passive tap; core keeps only what it archives. */
  applyGatewayEvent(t: ArchivedGatewayEvent, d: unknown): void;
  /** A server's whole role list, as main reads it from READY and GUILD_CREATE (too large to forward whole). */
  replaceGuildRoles(guildId: string, roles: RawRole[]): void;
  /** Server owners, channel overwrites and the owner's roles, as main reads them from the gateway (READY is too large to forward). */
  applyAccessFacts(f: AccessFacts): void;
  /** Discord's unread mention counts as main keeps them; `replace`: every channel's (READY), the rest drop to zero. */
  putReadStates(counts: ReadStateCount[], replace: boolean): void;
  /** Main added or removed the owner's reaction on Discord: the archive shows it before the gateway echo (which then changes nothing). */
  applyOwnReaction(r: OwnerReaction): void;
  syncState(channelId: string): SyncState;
  /** Marks deleted every stored message of the channel in [sinceTs, untilTs] that a fresh fetch no longer returned; returns how many. */
  reconcileDeletes(channelId: string, seenIds: string[], sinceTs: number, untilTs: number): number;
  messagePage(q: MessagePageQuery): ArchiveMessage[];
  /** One archived message as the Archive shows it; null when not archived or hidden by privacy mode. */
  messageById(messageId: string): ArchiveMessage | null;
  searchMessages(text: string, limit: number): SearchHit[];
  /** One person's footprint in the archive; null when the archive has never seen them. */
  personProfile(userId: string): PersonProfile | null;
  /** The last Discord profile of a person, as seen in a server (null outside one); null before the first fetch. */
  discordProfile(userId: string, guildId: string | null): DiscordProfile | null;
  /** Main fetched a profile from Discord: cache it (and the names it carries); returns it as the Person window shows it. */
  storeDiscordProfile(f: FetchedProfile): DiscordProfile;
  mutualFriends(userId: string): MutualFriends | null;
  storeMutualFriends(userId: string, friends: RawUser[], fetchedAt: number): MutualFriends;
  /** Who reacted with an emoji (a custom emoji's id, else the emoji); null before the first fetch. */
  reactors(messageId: string, emojiKey: string): ReactionUsers | null;
  storeReactors(messageId: string, emojiKey: string, users: RawUser[], count: number, fetchedAt: number): ReactionUsers;
  /** People whose name, username or a server nickname contains `query`, by name. */
  findPeople(query: string, limit: number): PersonMatch[];
  /**
   * What to `@` in a channel matching `query`, as Discord's autocomplete: people who can see it, then @everyone and @here
   * (when the owner may mention everyone) and roles, `limit` in all.
   */
  mentionCandidates(channelId: string, query: string, limit: number): MentionCandidate[];
  /** These people as pickers name them; unknown ids are left out. */
  peopleByIds(ids: string[]): PersonMatch[];
  /** How these people's names show in a channel (null: no place), as Discord draws them there; unknown ids are left out. */
  personNames(ids: string[], channelId: string | null): PersonName[];
  /** The exchange a message belongs to (reply chain, then nearby messages by its participants). */
  conversation(messageId: string): ConversationView;
  /** The signed-in user's most-used emoji in their archived messages, most used first; empty before READY names them. */
  ownEmoji(limit: number): UsedEmoji[];
  /** The signed-in user's most-used reactions in the archive, most used first. */
  ownReactions(limit: number): ArchiveEmoji[];
  /** The signed-in user's most-used slash commands in apps' archived replies, most used first; empty before READY names them. */
  ownCommands(limit: number): UsedCommand[];
  /** Search hits through the active plugins' rankers (ctx.search.rerank); null when none changed them, so the full-text order stands. */
  rankSearch(text: string, hits: SearchHit[]): Promise<SearchHit[] | null>;
  /** The owner's rules, in run order. */
  rules(): Rule[];
  /** Throws with a message for the editor. Returns the new rule's id. */
  createRule(input: RuleInput): number;
  updateRule(id: number, input: RuleInput): void;
  deleteRule(id: number): void;
  /** A rule's latest runs, newest first. */
  ruleRuns(ruleId: number, limit: number): RuleRun[];
  /** What a keyword pattern would match among recent archived messages in a scope (the keyword editor's check). */
  patternPreview(pattern: string, channelIds: string[] | null, contains: ContentKind[] | null): PatternPreview;
  pendingAttachments(limit: number): PendingAttachment[];
  attachmentStored(id: string, sha256: string, bytes: number): void;
  attachmentFailed(id: string, error: string): void;
  pendingEmojis(limit: number): PendingEmoji[];
  /** `error` null = stored. */
  emojiDone(id: string, error: string | null): void;
  /** Stores a sync page and advances the channel's sync cursors atomically. */
  ingestSyncPage(channelId: string, page: RawMessage[], direction: 'newer' | 'older', reachedEnd: boolean): IngestResult;
}

export type CoreMethod = keyof CoreMethods;
