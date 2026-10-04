// The one place that writes private channels (docs/dms.md §3.5): each write in the live client's own request shape,
// checked first (dmChecks.ts), and each channel Discord answers with stored in core at once through the gateway's merge
// path, so the gateway's echo changes nothing and no write waits for it. A close is the exception: the gateway closes it.
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

/**
 * The locations the live client names for these actions (its action creators, read 2026-10-01). `direct`: a DM opened
 * from a profile or another DM open, for which it names none.
 */
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

  /**
   * Starts a conversation with `recipients`, as the client's New Group DM does. One person the owner already has an
   * open DM with sends nothing. Sent once: with no clear answer it may exist, so it is never sent again. `archive`, the
   * owner's choice for a new conversation, applies as core first stores it. One Discord answers with that core held
   * before (a closed DM reopened) is `opened`, and keeps its own archive state.
   */
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

  /**
   * Adds friends, one PUT each in order, as the client does. On a one-to-one DM the first makes a new group (201, its
   * channel), sent once as a start is, and `archive` applies to it as core first stores it; the rest join that group (204).
   * A PUT failing after one went through ends it with the rest `failed`, named against the conversation they'd join.
   */
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
        // A new group Discord didn't name: adding the rest to the DM would make more groups.
        return { kind: this.uncertainUnlessRefused(new Error('No group in the answer.'), path) };
      } else {
        const user = this.d.friends.user(userId);
        if (user) await this.store(as, 'CHANNEL_RECIPIENT_ADD', { channel_id: target, user });
      }
    }
    return reached();
  }

  /**
   * Closes a DM or leaves a group: one call. A DM closes as the client closes one (silent=false); a group can be left
   * quietly. Sent once: a retry after a server error could find it gone (Unknown Channel). Core closes it on the
   * gateway's CHANNEL_DELETE only, never on this answer, which can land after a newer reopen.
   */
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

  /**
   * Every private channel core holds, taken before a write that may make one: the gateway can store a new one before
   * Discord's answer arrives, so being held after it says nothing.
   */
  private async knownChannels(): Promise<Set<string>> {
    return new Set(await this.d.core.call('privateChannelIds'));
  }

  /**
   * The account a write is checked and sent as: named by READY in main and in core alike (else READY is still arriving),
   * with a guard that stops the write unsent once another account signs in.
   */
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

  /**
   * Discord's answer, merged as the gateway's own copy of it is (idempotent with that later dispatch), under the account
   * it was sent as; core skips it once another account signed in.
   */
  private async store(as: SignedIn, t: Extract<ArchivedGatewayEvent, `CHANNEL_${string}`>, payload: unknown, archive?: boolean): Promise<void> {
    await this.d.core.call('applyDmWrite', as.account, t, payload, archive);
  }
}
