// Validates private-channel writes and immediately merges Discord responses into core. Gateway echoes are idempotent; close state changes only through gateway events.
import { DM_CHANNEL_TYPE, DM_CHANNEL_TYPES, DiscordHttpError, GROUP_DM_CHANNEL_TYPE, snowflakeArg, type RawPrivateChannel } from '@shared/discord';
import { DM_UNCERTAIN_TEXT, MUTE_UNTIL_UNMUTED, isMuteWindow, type DmOutcome, type PrivateChannelFacts } from '@shared/dms';
import type { ArchivedGatewayEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { PostingLocked } from '@shared/posting';
import { MS_PER_S } from '@shared/units';
import type { MainCore } from '../coreClient';
import { redactIds } from '../diagnostics';
import { DiscordAuthError } from './api';
import type { DiscordWriter, RequestContext } from './client';
import { checkAdd, checkArchiveChoice, checkManageable, checkRename, checkStart, type Friends } from './dmChecks';

/** Client action locations; direct profile/DM opens omit location. */
export const DM_CONTEXT = {
  start: { location: 'New Group DM' },
  add: { location: 'Add Friends to DM' },
  direct: {},
} as const satisfies Record<string, RequestContext>;

/** Statuses Discord answers a refused request with; from SERVER_ERROR_MIN up, a request may have applied. */
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;
const SETTINGS_PATH = 'users/@me/guilds/@me/settings';

/** A DM or group DM as Discord answers a write with it. */
const isChannel = (v: unknown): v is RawPrivateChannel => {
  const c = v as Partial<RawPrivateChannel> | null;
  return !!c && typeof c.id === 'string' && typeof c.type === 'number' && DM_CHANNEL_TYPES.has(c.type);
};

/** Thrown before a write goes when another account signed in after it was checked: nothing was sent. */
export class AccountChangedError extends Error {
  constructor() {
    super('Another Discord account signed in: nothing was sent.');
  }
}

export interface DmServiceDeps {
  /** DiscordApi.prompt: the owner is waiting. */
  api: DiscordWriter;
  core: Pick<MainCore, 'call'>;
  /** The account main's READY last named (OwnerAccount); the friend list is that account's (FriendIndex resets per READY). */
  account: () => string | null;
  friends: Friends;
  /** Discord's answer to a mute: the owner's DM notification settings (ReadStates.settingsChanged). */
  settingsChanged: (settings: unknown) => void;
  /** Session notes (diagnostics.log): paths without ids, never content. */
  diag: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

/** The account a write was checked as, and its send guard (RequestOptions.guard). */
interface SignedIn {
  account: string;
  guard: () => void;
}

export class DmService {
  constructor(private readonly d: DmServiceDeps) {}

  /** Starts conversations once; existing open one-person DMs need no request. New channels receive chosen archive state; reopened known channels retain theirs. */
  async start(recipients: unknown, archive?: unknown): Promise<DmOutcome> {
    return this.open(recipients, checkArchiveChoice(archive), DM_CONTEXT.start);
  }

  /** The owner's DM with one person (the profile's Message, Discord's /msg): the open one, else a new one. */
  async dmWith(userId: unknown): Promise<string> {
    const outcome = await this.open([userId], undefined, DM_CONTEXT.direct);
    if (outcome.kind === 'uncertain') throw new Error(DM_UNCERTAIN_TEXT);
    return outcome.channelId;
  }

  /** A start (see start) in the client's `context` for where it was asked. */
  private async open(recipients: unknown, choice: boolean | undefined, context: RequestContext): Promise<DmOutcome> {
    const as = await this.signedIn();
    const people = checkStart(recipients, as.account, this.d.friends);
    const existing = people.length === 1 ? await this.d.core.call('dmWith', people[0]!) : null;
    if (existing) return { kind: 'opened', channelId: existing };
    const known = await this.knownChannels();
    const path = 'users/@me/channels';
    let channel: RawPrivateChannel;
    try {
      channel = await this.d.api.postOnce<RawPrivateChannel>(path, { recipients: people }, { context, guard: as.guard });
    } catch (err) {
      return { kind: this.uncertainUnlessRefused(err, path) };
    }
    const made = !known.has(channel.id);
    await this.store(as, 'CHANNEL_CREATE', channel, made ? choice : undefined);
    return { kind: made ? 'created' : 'opened', channelId: channel.id };
  }

  /** Adds friends sequentially. First one-to-one addition creates a group once with chosen archive state; later additions join it. Failures report remaining recipients. */
  async add(channelId: unknown, userIds: unknown, archive?: unknown): Promise<DmOutcome> {
    const choice = checkArchiveChoice(archive);
    const as = await this.signedIn();
    const { id, facts } = await this.facts(channelId);
    const added = checkAdd(facts, userIds, as.account, this.d.friends);
    const known = facts.kind === DM_CHANNEL_TYPE ? await this.knownChannels() : new Set<string>();
    let target = id;
    const reached = (): Extract<DmOutcome, { channelId: string }> => (target === id ? { kind: 'opened', channelId: id } : { kind: 'created', channelId: target });
    for (const [i, userId] of added.entries()) {
      const path = `channels/${target}/recipients/${userId}`;
      const makesGroup = target === id && facts.kind === DM_CHANNEL_TYPE;
      let answer: unknown;
      try {
        answer = await this.d.api.put(path, { context: DM_CONTEXT.add, once: makesGroup, guard: as.guard });
      } catch (err) {
        if (makesGroup) return { kind: this.uncertainUnlessRefused(err, path) };
        this.noteRefusal(err, path);
        if (!i) throw err;
        return { ...reached(), failed: { userIds: added.slice(i), reason: errorMessage(err) } };
      }
      if (isChannel(answer)) {
        const made = answer.id !== target;
        await this.store(as, made ? 'CHANNEL_CREATE' : 'CHANNEL_UPDATE', answer, made && !known.has(answer.id) ? choice : undefined);
        target = answer.id;
      } else if (makesGroup) {
        // Stop after an unnamed new group; additional DM writes can create separate groups.
        return { kind: this.uncertainUnlessRefused(new Error('No group in the answer.'), path) };
      } else {
        const user = this.d.friends.user(userId);
        if (user) await this.store(as, 'CHANNEL_RECIPIENT_ADD', { channel_id: target, user });
      }
    }
    return reached();
  }

  /** Closes DMs or leaves groups once. Core closes only on CHANNEL_DELETE, avoiding stale responses overriding newer reopens. */
  async close(channelId: unknown, quietly: unknown): Promise<void> {
    if (quietly !== undefined && typeof quietly !== 'boolean') throw new Error('Leave quietly, or not.');
    const as = await this.signedIn();
    const { id, facts } = await this.facts(channelId);
    checkManageable(facts);
    const path = `channels/${id}?silent=${facts.kind === GROUP_DM_CHANNEL_TYPE && quietly === true}`;
    await this.write(path, () => this.d.api.delete(path, { once: true, guard: as.guard }));
  }

  async rename(channelId: unknown, name: unknown): Promise<void> {
    const as = await this.signedIn();
    const { id, facts } = await this.facts(channelId);
    const n = checkRename(facts, name);
    const path = `channels/${id}`;
    const answer = await this.write(path, () => this.d.api.patch<unknown>(path, { name: n }, { guard: as.guard }));
    if (isChannel(answer)) await this.store(as, 'CHANNEL_UPDATE', answer);
  }

  /** Mutes a DM for one of the client's lengths, or unmutes it (null), in the owner's DM notification settings. */
  async mute(channelId: unknown, window: unknown): Promise<void> {
    if (window !== null && !isMuteWindow(window)) throw new Error('Not a mute length.');
    const as = await this.signedIn();
    const { id, facts } = await this.facts(channelId);
    checkManageable(facts);
    const endTime = (w: number): string | null => (w === MUTE_UNTIL_UNMUTED ? null : new Date((this.d.now ?? Date.now)() + w * MS_PER_S).toISOString());
    const override = window === null ? { muted: false } : { muted: true, mute_config: { selected_time_window: window, end_time: endTime(window) } };
    const answer = await this.write(SETTINGS_PATH, () => this.d.api.patch<unknown>(SETTINGS_PATH, { channel_overrides: { [id]: override } }, { guard: as.guard }));
    // Not into another account's read states: that account's gateway reports its own.
    if (this.d.account() === as.account) this.d.settingsChanged(answer);
  }

  /** `channelId` checked as a DM or group DM of the account signed in (a server channel is none). */
  private async facts(channelId: unknown): Promise<{ id: string; facts: PrivateChannelFacts }> {
    const id = snowflakeArg(channelId, 'channel');
    const facts = await this.d.core.call('privateChannel', id);
    if (!facts) throw new Error('Not a direct message of the account signed in.');
    return { id, facts };
  }

  /** Snapshots held private channels before writes; gateway events may insert new channels before REST responses. */
  private async knownChannels(): Promise<Set<string>> {
    return new Set(await this.d.core.call('privateChannelIds'));
  }

  /** Requires matching main/core READY account identity. Guard prevents unsent writes after account changes. */
  private async signedIn(): Promise<SignedIn> {
    const self = await this.d.core.call('selfId');
    if (!self || self !== this.d.account()) throw new Error('Discord is still loading: try again once it has.');
    return {
      account: self,
      guard: () => {
        if (this.d.account() !== self) throw new AccountChangedError();
      },
    };
  }

  /** Runs a write whose repeat is harmless; a refusal is logged with its path. */
  private async write<T>(path: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      this.noteRefusal(err, path);
      throw err;
    }
  }

  /** Logs a write Discord refused (a 4xx) with its path, ids left out. */
  private noteRefusal(err: unknown, path: string): boolean {
    if (!(err instanceof DiscordHttpError && err.status >= CLIENT_ERROR_MIN && err.status < SERVER_ERROR_MIN)) return false;
    this.d.diag('dm-write-refused', { path: redactIds(path), status: err.status });
    return true;
  }

  /**
   * A write sent once: a refusal, no session, another account signed in or posting locked (nothing sent) fails; anything else may have
   * applied, so it is uncertain.
   */
  private uncertainUnlessRefused(err: unknown, path: string): 'uncertain' {
    if (this.noteRefusal(err, path) || err instanceof DiscordAuthError || err instanceof AccountChangedError || err instanceof PostingLocked) throw err;
    this.d.diag('dm-write-uncertain', { path: redactIds(path) });
    return 'uncertain';
  }

  /** Merges responses idempotently under the sending account. Core skips them if another account signed in. */
  private async store(as: SignedIn, t: Extract<ArchivedGatewayEvent, `CHANNEL_${string}`>, payload: unknown, archive?: boolean): Promise<void> {
    await this.d.core.call('applyDmWrite', as.account, t, payload, archive);
  }
}
