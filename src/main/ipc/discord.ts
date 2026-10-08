import { ipcMain, type BrowserWindow, type Session } from 'electron';
import { votePollAsOwner } from '../discord/polls';
import { handleMain } from './mainCalls';
import { MAIN_INVOKE } from '@shared/contract';
import type { CommandChoice, CommandIndex, GuildRole, InteractionOutcome } from '@shared/commands';
import { uploadLimitBytes, type ExpressionCatalog } from '@shared/compose';
import type { DiscordProfile, MutualFriends, ReactionUsers } from '@shared/types/discordProfile';
import { DM_GUILD_ID, isReactionEmoji, snowflakeArg } from '@shared/discord';
import { normalizeSyncedChatChange } from '@shared/chatSettings';
import { errorMessage } from '@shared/errors';
import type { CoreClient } from '../coreClient';
import { diag } from '../diagnostics';
import { OwnerAccount } from '../discord/account';
import { OwnerTyping } from '../discord/ownTyping';
import type { GatewayDirectory } from '../discord/directory';
import { fetchDiscordCustomTheme } from '../discord/appearance';
import type { AccountChatSettings } from '../discord/chatSettings';
import type { DiscordClient } from '../discord/client';
import { CommandIndexes } from '../discord/commandIndex';
import type { HeaderCapture } from '../discord/capture';
import { searchGifs } from '../discord/gifs';
import { fetchMutualFriends, fetchProfile, fetchReactors, FriendIndex } from '../discord/profiles';
import type { GuildEmojiIndex } from '../discord/guildEmojis';
import type { ReadStates } from '../discord/readStates';
import { Interactions } from '../discord/interactions';
import { probeDiscord, trackRecentMessageEvents } from '../discord/probe';
import { MemberRequests } from '../discord/memberRequests';
import { GuildRoleIndex } from '../discord/roles';
import { createThread, deleteOwnerMessage, editOwnerMessage, forwardAsOwner, reactAsOwner, sendDirect, sendOwnerMessage } from '../discord/send';
import { GuildStickerIndex, StickerPacks } from '../discord/stickers';
import { GuildTiers } from '../discord/guildTiers';
import { Uploads } from '../discord/uploads';
import type { DiscordView } from '../discordView';
import type { SyncService } from '../sync/syncService';
import { PHONE_DISCORD_METHODS } from '@shared/phone';
import type { DiscordCalls } from '../phone/hub';
import { gatePosting, postingClient, type PostingGate } from '../plugins/posting';
import { registerDmHandlers } from './dms';
import { ScheduledGate } from '../discord/scheduledAvailability';
import { ScheduledMessages } from '../discord/scheduledMessages';

/** Channel kinds a suggestion samples: text and announcement channels (not DMs, threads or forums). */
const SUGGESTABLE_KINDS = new Set([0, 5]);

export interface DiscordDeps {
  win: BrowserWindow;
  core: CoreClient;
  sync: SyncService;
  /** DiscordApi.prompt: every request here is one the owner made, so none is held back. */
  owner: DiscordClient;
  capture: HeaderCapture;
  discord: DiscordView;
  emojiIndex: GuildEmojiIndex;
  /** Discord's answer to a DM mute reaches the read states. */
  readStates: Pick<ReadStates, 'settingsChanged'>;
  /** Posting calls (@shared/posting) refuse while it is locked. */
  posting: PostingGate;
  /** The embedded client's session: uploads to Discord's attachment store go through it. */
  discordSession: Session;
  /** The account's chat settings: writes go through it, one at a time. */
  chatSettings: Pick<AccountChatSettings, 'write'>;
  /** Servers and channels from the client's gateway. */
  directory: Pick<GatewayDirectory, 'guildList'>;
}

/** Validates renderer Discord ids and synchronously attaches gateway listeners during window creation. Returns equally gated calls for the phone. */
export function registerDiscordHandlers(d: DiscordDeps): DiscordCalls {
  const { discord: channels } = MAIN_INVOKE;
  ipcMain.handle(channels.refreshDirectory, (_e, guildId: unknown) =>
    d.sync.refreshDirectory(guildId === undefined || guildId === DM_GUILD_ID ? guildId : snowflakeArg(guildId, 'server')),
  );
  // Posting calls' requests go through `poster`, which checks the lock before every attempt; reactions and reads don't.
  const poster = postingClient(d.owner, d.posting);
  const account = new OwnerAccount(d.discord.tap);
  const tiers = new GuildTiers(d.discord.tap);
  /** The plan's limit, or the channel's server's Boost limit when larger; a channel not in the directory (a DM) gets the plan's. */
  const limitFor = async (channelId: string): Promise<number> => {
    const guild = (await d.core.call('directory')).find((g) => g.id !== DM_GUILD_ID && g.channels.some((c) => c.id === channelId));
    return uploadLimitBytes(account.premiumType, guild ? tiers.tier(guild.id) : null);
  };
  const uploads = new Uploads(d.discordSession, limitFor);
  const scheduledGate = new ScheduledGate(d.discord.tap, account);
  const scheduled = new ScheduledMessages(poster, () => scheduledGate.account, uploads);
  const scheduledCalls = gatePosting(d.posting, {
    createScheduled: (m: unknown) => scheduled.create(m), updateScheduled: (u: unknown) => scheduled.update(u),
    cancelScheduled: (id: unknown) => scheduled.remove(id), sendScheduledNow: (id: unknown) => scheduled.remove(id, true),
  });
  handleMain(channels.scheduledAvailability, (channelId) => scheduled.availability(channelId));
  handleMain(channels.scheduledMessages, () => scheduled.list());
  handleMain(channels.createScheduled, scheduledCalls.createScheduled);
  handleMain(channels.updateScheduled, scheduledCalls.updateScheduled);
  handleMain(channels.cancelScheduled, scheduledCalls.cancelScheduled);
  handleMain(channels.sendScheduledNow, scheduledCalls.sendScheduledNow);
  const send = (m: unknown): ReturnType<typeof sendOwnerMessage> => sendOwnerMessage(poster, m, uploads);
  const uploadLimit = (channelId: unknown): Promise<number> => limitFor(snowflakeArg(channelId, 'channel'));
  const prepareUploads = (channelId: unknown, files: unknown) => uploads.prepare(poster, channelId, files);
  const uploadChunk = (token: unknown, offset: unknown, bytes: unknown): Promise<void> => uploads.chunk(token, offset, bytes);
  const finishUpload = (token: unknown): Promise<void> => uploads.finish(token);
  const gifs = (query: unknown): ReturnType<typeof searchGifs> => searchGifs(d.owner, d.capture, query);
  const edit = (e: unknown): Promise<void> => editOwnerMessage(poster, e);
  const deleteMessage = (m: unknown): Promise<void> => deleteOwnerMessage(poster, m);
  const forward = (f: unknown): Promise<void> => forwardAsOwner(poster, f);
  // The archive takes the reaction before this resolves, so the renderer's refresh shows it.
  const react = async (r: unknown): Promise<void> => d.core.call('applyOwnReaction', await reactAsOwner(d.owner, r));
  // A vote is a post (locked as one); the archive takes it before this resolves, as a reaction.
  const votePoll = async (v: unknown): Promise<void> => d.core.call('applyOwnPollVote', await votePollAsOwner(poster, v));
  handleMain(channels.customTheme, () => fetchDiscordCustomTheme(d.owner));
  // The archive's copy of the account's settings holds the change before this resolves.
  const setChatSettings = async (change: unknown): Promise<void> => {
    const valid = normalizeSyncedChatChange(change);
    if (Object.keys(valid).length === 0) throw new Error('Not a chat settings change.');
    await d.chatSettings.write(valid);
  };

  const stickerIndex = new GuildStickerIndex(d.discord.tap);
  const stickerPacks = new StickerPacks();
  const expressions = async (guildId: unknown): Promise<ExpressionCatalog> => {
    // The channel's own server is fetched when the gateway didn't cover it: its emoji and stickers need no Nitro.
    if (guildId !== DM_GUILD_ID) {
      const id = snowflakeArg(guildId, 'server');
      await Promise.all([d.emojiIndex.forGuild(d.owner, id), stickerIndex.forGuild(d.owner, id)]);
    }
    const packs = await stickerPacks.get(d.owner).catch((err: unknown) => {
      diag('sticker-packs-failed', { message: errorMessage(err) });
      return [];
    });
    return { emojis: d.emojiIndex.all(), stickers: stickerIndex.all(), packs, perks: account.perks };
  };

  const commandIndexes = new CommandIndexes(d.discord.tap);
  const roleIndex = new GuildRoleIndex(d.discord.tap);
  const interactions = new Interactions(d.discord.tap, poster, account);
  const commands = (channelId: unknown, guildId: unknown): Promise<CommandIndex> =>
    commandIndexes.forChannel(d.owner, snowflakeArg(channelId, 'channel'), guildId === null ? null : snowflakeArg(guildId, 'server'));
  const roles = (guildId: unknown): Promise<GuildRole[]> => roleIndex.forGuild(d.owner, snowflakeArg(guildId, 'server'));
  const runCommand = (run: unknown): Promise<InteractionOutcome> => interactions.runCommand(run);
  const autocomplete = (req: unknown): Promise<CommandChoice[]> => interactions.autocomplete(req);
  const useComponent = (use: unknown): Promise<InteractionOutcome> => interactions.useComponent(use);
  const submitModal = (submit: unknown): Promise<InteractionOutcome> => interactions.submitModal(submit);
  // Passive member enrichment: no socket discovery or additional Discord requests.
  const memberRequests = new MemberRequests();
  const requestMembers = async (guildId: unknown, query: unknown): Promise<void> => {
    if (typeof query !== 'string') throw new Error('Not a member search.');
    await memberRequests.request(snowflakeArg(guildId, 'server'), query);
  };
  const ownTyping = new OwnerTyping(d.discord.tap, account, poster);
  const typing = (channelId: unknown): Promise<void> => ownTyping.typing(snowflakeArg(channelId, 'channel'));
  const startThread = (t: unknown): Promise<void> => createThread(poster, t);
  // Friends from the client's gateway: the profile's Friends Since, and who a group may hold.
  const friends = new FriendIndex(d.discord.tap);
  const dms = registerDmHandlers({ core: d.core, owner: poster, account, friends, readStates: d.readStates, posting: d.posting });
  const direct = (m: unknown): Promise<void> => sendDirect(poster, (userId) => dms.dmWith(userId), m);
  // Only this server's text channels that aren't archived; samples go straight to Jev and are dropped.
  ipcMain.handle(channels.suggestChannels, async (_e, guildId: unknown) => {
    const id = snowflakeArg(guildId, 'server');
    const guild = (await d.core.call('directory')).find((g) => g.id === id);
    const candidates = (guild?.channels ?? []).filter((c) => !c.optedIn && SUGGESTABLE_KINDS.has(c.kind)).map((c) => ({ id: c.id, name: c.name }));
    return d.core.call('suggestChannels', await d.sync.sampleChannels(candidates));
  });
  ipcMain.handle(channels.setOptIn, async (_e, channelId: unknown, on: unknown) => {
    const id = snowflakeArg(channelId, 'channel');
    if (typeof on !== 'boolean') throw new Error('Opt in or out.');
    // Core's opt-in-changed names the channel; main syncs it from there (app.ts), as for auto-archive.
    await d.core.call('setOptIn', id, on);
  });

  // Discord's own profile and reactor answers: fetched now, cached by core, returned as core reads them back.
  const profile = async (userId: unknown, guildId: unknown): Promise<DiscordProfile> => {
    const id = snowflakeArg(userId, 'user');
    const fetched = await fetchProfile(d.owner, friends, id, guildId === null ? null : snowflakeArg(guildId, 'server'));
    return d.core.call('storeDiscordProfile', fetched);
  };
  const mutualFriends = async (userId: unknown): Promise<MutualFriends> => {
    const id = snowflakeArg(userId, 'user');
    return d.core.call('storeMutualFriends', id, await fetchMutualFriends(d.owner, id), Date.now());
  };
  const reactors = async (channelId: unknown, messageId: unknown, emoji: unknown, count: unknown): Promise<ReactionUsers> => {
    const msg = snowflakeArg(messageId, 'message');
    if (!isReactionEmoji(emoji)) throw new Error('Not a reaction emoji.');
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Not a reaction count.');
    const users = await fetchReactors(d.owner, snowflakeArg(channelId, 'channel'), msg, emoji);
    return d.core.call('storeReactors', msg, emoji.id ?? emoji.name, users, count as number, Date.now());
  };

  const recent = trackRecentMessageEvents(d.discord.tap);
  ipcMain.handle(channels.shownChannel, () => d.discord.shownChannel ?? null);
  ipcMain.handle(channels.probe, () => probeDiscord(d.capture, d.discord.tap, recent, account, d.directory));
  // One gate for the window's and the phone's calls: posting calls refuse while posting is locked.
  const calls: DiscordCalls = gatePosting(d.posting, { send, uploadLimit, prepareUploads, uploadChunk, finishUpload, edit, deleteMessage, forward, react, gifs, expressions, commands, runCommand, autocomplete, useComponent, submitModal, roles, requestMembers, typing, createThread: startThread, votePoll, sendDirect: direct, profile, mutualFriends, reactors, setChatSettings });
  for (const name of PHONE_DISCORD_METHODS) ipcMain.handle(channels[name], (_e, ...args: unknown[]) => calls[name](...args));
  return calls;
}
