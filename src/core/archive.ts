import { MESSAGE_FLAG } from '@shared/components';
import { ArchiveMessages } from './archiveMessages';
import type { NoteArchiveChange } from '@shared/archiveChanges';
import type { ChannelInfo, ChannelPolicy, IngestResult, SyncState } from '@shared/contract';
import {
  compareSnowflakes,
  snowflakeArg,
  snowflakeToMs,
  type RawChannel,
  type RawGuild,
  type RawMember,
  type RawMemberPatch,
  type MemberPayloadMode,
  type RawMessage,
  type RawMessageUpdate,
  type RawPrivateChannel,
  type RawThread,
  type RawUser,
  type RawUserPatch,
} from '@shared/discord';
import type { Db } from './db';
import { markMemberLeft, upsertMembers, upsertUser } from './people';
import {
  autoArchivable,
  changeRecipient,
  closePrivateChannel,
  replacePrivateChannels,
  syncedChannelSql,
  touchChannel,
  upsertPrivateChannel,
  type Touch,
} from './privateChannels';
import { applyRoleChange, type RoleChange } from './roles';
import { THREAD_KINDS_SQL } from './queries/channelScope';
import { rawJsonSql } from './queries/messageContent';
import { applyReactionEvent, type ReactionEvent } from './reactions';
import { applyOwnPollVoteTo, applyPollVoteEvent, type PollVoteEvent } from './pollVotes';
import type { OwnerPollVote } from '@shared/polls';
import { ARRIVAL, type Arrival, type Arrived, type TextMessage } from './arrival';
import { syncCursor, syncState } from './queries/syncState';

/** Archive reads/writes. All message mutation goes through here so edits and deletes are never lost. */
export class Archive {
  private readonly messageWriter: ArchiveMessages;
  private readonly optedIn = new Set<string>();
  private readonly changeFrames: Parameters<NoteArchiveChange>[][] = [];

  constructor(
    private readonly db: Db,
    /** Sees every new or changed message text (topics, rules), with how and when it arrived. */
    private readonly onText: (m: TextMessage, arrived: Arrived) => void = () => {},
    /** Reports unchanged messages whose linked text arrived after ingestion. */
    private readonly onLinkedText: (m: TextMessage, arrived: Arrived) => void = () => {},
    /** Sees a message stored or updated (embeds arrive by update): the images it shows may be new. */
    private readonly onShown: (messageId: string) => void = () => {},
    private onChange: NoteArchiveChange = () => {},
  ) {
    this.messageWriter = new ArchiveMessages(db, (id) => this.optedIn.has(id), onText, onLinkedText, onShown, (id, kinds, opts) => this.reportChange(id, kinds, opts));
    this.loadOptedIn();
  }

  /** Binds the handler host that owns notifications for subsequent archive writes. */
  reportChangesWith(changed: NoteArchiveChange): void { this.onChange = changed; }

  private reportChange(...change: Parameters<NoteArchiveChange>): void {
    const frame = this.changeFrames.at(-1);
    if (frame) frame.push(change); else this.onChange(...change);
  }

  /** The opted-in channels as the database holds them (the in-memory mirror every ingest checks). */
  private loadOptedIn(): void {
    this.optedIn.clear();
    for (const r of this.db.prepare('SELECT id FROM channels WHERE opted_in = 1').all() as { id: string }[]) this.optedIn.add(r.id);
  }

  /** Runs `fn` as one transaction: all of its writes or none. A rollback also undoes opt-ins it made in memory. */
  atomically<T>(fn: () => T): T {
    const frame: Parameters<NoteArchiveChange>[] = [];
    this.changeFrames.push(frame);
    let result: T;
    try { result = this.db.transaction(fn)(); }
    catch (err) { this.changeFrames.pop(); this.loadOptedIn(); throw err; }
    this.changeFrames.pop();
    frame.forEach((change) => this.reportChange(...change));
    return result;
  }

  upsertGuilds(guilds: RawGuild[]): boolean {
    const stmt = this.db.prepare(
      `INSERT INTO guilds (id, name, icon, features) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, features = COALESCE(excluded.features, guilds.features)
       WHERE guilds.name IS NOT excluded.name OR guilds.icon IS NOT excluded.icon
         OR guilds.features IS NOT COALESCE(excluded.features, guilds.features)`,
    );
    const changed = this.db.transaction(() => guilds.reduce((count, g) => count + stmt.run(g.id, g.name, g.icon ?? null, g.features ? JSON.stringify(g.features) : null).changes, 0))() > 0;
    if (changed) this.reportChange('', ['channels', 'names']);
    return changed;
  }

  upsertChannels(guildId: string, channels: RawChannel[]): boolean {
    const stmt = this.db.prepare(
      `INSERT INTO channels (id, guild_id, name, kind, parent_id, position, overwrites) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id, position = excluded.position,
         overwrites = COALESCE(excluded.overwrites, channels.overwrites)
       WHERE channels.name IS NOT excluded.name OR channels.kind IS NOT excluded.kind
         OR channels.parent_id IS NOT excluded.parent_id OR channels.position IS NOT excluded.position
         OR channels.overwrites IS NOT COALESCE(excluded.overwrites, channels.overwrites)`,
    );
    const changed = this.db.transaction(() => channels.reduce((count, c) => count +
      stmt.run(c.id, guildId, c.name, c.type, c.parent_id ?? null, c.position ?? null, c.permission_overwrites ? JSON.stringify(c.permission_overwrites) : null).changes, 0))() > 0;
    if (changed) this.reportChange('', ['channels', 'names'], { nameGuildIds: [guildId] });
    return changed;
  }

  /** READY's DM list for `accountId` (privateChannels.ts): listed DMs open; unless `partial`, the account's others close. */
  replacePrivateChannels(accountId: string, channels: RawPrivateChannel[], partial: boolean, now: number): void {
    replacePrivateChannels(this.db, accountId, channels, partial, now);
  }

  /** One DM from a gateway delta, merged field by field; `opened`: Discord lists it again (CHANNEL_CREATE). */
  upsertPrivateChannel(accountId: string | null, c: RawPrivateChannel, opened: boolean): void {
    this.db.transaction(() => upsertPrivateChannel(this.db, accountId, c, opened))();
  }

  /** A DM's newest message id, raised (never lowered) before the message is ingested; stores no content. */
  touchChannel(channelId: string, messageId: string): Touch {
    return this.db.transaction(() => touchChannel(this.db, channelId, messageId))();
  }

  /** Archives a DM of `selfId` that auto-archive's gate admits (autoArchivable); returns whether it did. */
  autoArchive(channelId: string, selfId: string | null): boolean {
    return this.db.transaction(() => {
      if (!autoArchivable(this.db, channelId, selfId)) return false;
      this.setOptIn(channelId, true);
      return true;
    })();
  }

  closePrivateChannel(channelId: string, now: number): boolean {
    return closePrivateChannel(this.db, channelId, now);
  }

  changeRecipient(channelId: string, user: RawUser, added: boolean, selfId: string | null): boolean {
    return this.db.transaction(() => changeRecipient(this.db, channelId, user, added, selfId))();
  }

  /** Archives threads with archived parents. Returns threads needing activity sync or unfinished backfill within the requested window. */
  upsertThreads(threads: RawThread[], backfillFromMs: number | ((channelId: string) => number)): string[] {
    const stmt = this.db.prepare(
      `INSERT INTO channels (id, guild_id, name, kind, parent_id, opted_in)
       SELECT ?, p.guild_id, ?, ?, p.id, 1 FROM channels p WHERE p.id = ? AND p.opted_in = 1
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id, opted_in = 1`,
    );
    const stale: string[] = [];
    this.db.transaction(() => {
      for (const t of threads) {
        if (!stmt.run(t.id, t.name, t.type, t.parent_id).changes) continue;
        this.optedIn.add(t.id);
        const cutoffMs = typeof backfillFromMs === 'number' ? backfillFromMs : backfillFromMs(t.id);
        const s = syncCursor(this.db, t.id);
        const newer = t.last_message_id && (!s.newestId || compareSnowflakes(t.last_message_id, s.newestId) > 0);
        const backfillLeft = !s.backfillComplete && (!s.oldestId || snowflakeToMs(s.oldestId) > cutoffMs);
        if (newer || (backfillLeft && t.last_message_id)) stale.push(t.id);
      }
    })();
    return stale;
  }

  channelInfo(channelId: string): ChannelInfo | null {
    const r = this.db.prepare('SELECT kind, guild_id AS guildId, parent_id AS parentId FROM channels WHERE id = ?').get(channelId) as ChannelInfo | undefined;
    return r ?? null;
  }

  setChannelPolicy(channelId: string, p: ChannelPolicy): void {
    if (p.localAiOnly !== undefined) this.db.prepare('UPDATE channels SET local_ai_only = ? WHERE id = ?').run(p.localAiOnly ? 1 : 0, channelId);
    if (p.textTier !== undefined) this.db.prepare('UPDATE channels SET text_tier = ? WHERE id = ?').run(p.textTier, channelId);
    if (p.hideInPrivacy !== undefined) this.db.prepare('UPDATE channels SET hide_in_privacy = ? WHERE id = ?').run(p.hideInPrivacy ? 1 : 0, channelId);
  }

  /** Snowflake ids only: a hidden server's id is matched inside message text (hidden_ids), so '@me' may not be marked. */
  setGuildHideInPrivacy(guildId: string, on: boolean): void {
    this.db.prepare('UPDATE guilds SET hide_in_privacy = ? WHERE id = ?').run(on ? 1 : 0, snowflakeArg(guildId, 'server'));
  }

  /** Opting a channel in or out applies to its known threads too. */
  setOptIn(channelId: string, on: boolean): void {
    const threads = (this.db.prepare(`SELECT id FROM channels WHERE parent_id = ? AND kind IN (${THREAD_KINDS_SQL})`).all(channelId) as { id: string }[]).map(
      (r) => r.id,
    );
    const stmt = this.db.prepare('UPDATE channels SET opted_in = ? WHERE id = ?');
    this.db.transaction(() => [channelId, ...threads].forEach((id) => stmt.run(on ? 1 : 0, id)))();
    for (const id of [channelId, ...threads]) {
      if (on) this.optedIn.add(id);
      else this.optedIn.delete(id);
    }
  }

  /**
   * Archived channels sync keeps current for `selfId` (syncedChannelSql), excluding threads: sync reaches those through
   * their parent's thread discovery.
   */
  optedInChannels(selfId: string | null): string[] {
    return (
      this.db.prepare(`SELECT c.id FROM channels c WHERE ${syncedChannelSql('c')} AND c.kind NOT IN (${THREAD_KINDS_SQL})`).all({ self: selfId ?? '' }) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /** Whether sync still keeps `channelId` (a thread too) for `selfId`: checked before each page it fetches. */
  syncable(channelId: string, selfId: string | null): boolean {
    return this.db.prepare(`SELECT 1 FROM channels c WHERE c.id = @id AND ${syncedChannelSql('c')}`).get({ id: channelId, self: selfId ?? '' }) !== undefined;
  }

  isOptedIn(channelId: string): boolean {
    return this.optedIn.has(channelId);
  }

  ingestMessages(messages: RawMessage[], via: Arrival): IngestResult { return this.messageWriter.ingestMessages(messages, via); }
  applyUpdate(update: RawMessageUpdate): void { this.messageWriter.applyUpdate(update); }

  /** Poll vote events on an archived message (see pollVotes.ts); `selfId` tells the owner's own apart. */
  applyPollVote(t: 'MESSAGE_POLL_VOTE_ADD' | 'MESSAGE_POLL_VOTE_REMOVE', d: PollVoteEvent, selfId: string | null): boolean {
    return this.optedIn.has(d.channel_id) && applyPollVoteEvent(this.db, t, d, selfId);
  }

  /** The owner's vote on an archived poll, applied before the gateway's echo (which then changes nothing). */
  applyOwnPollVote(v: OwnerPollVote): boolean {
    return this.optedIn.has(v.channelId) && applyOwnPollVoteTo(this.db, v);
  }

  /** Reaction events on an archived message (see reactions.ts); `selfId` tells the owner's own apart. */
  applyReaction(t: string, d: ReactionEvent, selfId: string | null): boolean {
    return this.optedIn.has(d.channel_id) && applyReactionEvent(this.db, t, d, selfId);
  }

  /**
   * Marks stored messages from `fromId` through `throughId` (ids, both included) that a contiguous refetch of that range didn't return
   * as deleted, including retention-pruned rows. Excludes ephemeral messages, which never appear in history.
   */
  reconcileDeletes(channelId: string, seenIds: string[], fromId: string, throughId: string, at: number): number {
    if (!this.optedIn.has(channelId)) return 0;
    const seen = new Set(seenIds);
    // The column survives text retention; the payload also covers rows an older build stored in a shared profile.
    const ephemeral = `(ephemeral = 1 OR COALESCE(${rawJsonSql('$.flags', '')}, 0) & ${MESSAGE_FLAG.ephemeral} != 0)`;
    const stored = this.db
      .prepare(`SELECT id FROM messages WHERE channel_id = ? AND ts >= ? AND ts <= ? AND deleted_at IS NULL AND NOT ${ephemeral}`)
      .all(channelId, snowflakeToMs(fromId), snowflakeToMs(throughId)) as { id: string }[];
    // Ids within the bounds' milliseconds: another message of the same millisecond may lie outside the range.
    const inRange = (id: string): boolean => compareSnowflakes(id, fromId) >= 0 && compareSnowflakes(id, throughId) <= 0;
    const gone = stored.filter((r) => inRange(r.id) && !seen.has(r.id));
    const mark = this.db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
    this.db.transaction(() => gone.forEach((r) => mark.run(at, r.id)))();
    return gone.length;
  }

  /** Soft delete: the original stays readable and is shown as deleted. */
  markDeleted(channelId: string, messageId: string, at: number): void {
    if (!this.optedIn.has(channelId)) return;
    this.db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(at, messageId);
  }

  syncState(channelId: string): SyncState {
    return syncState(this.db, channelId);
  }

  /**
   * Stores one page fetched by sync and extends the synced range in the same transaction,
   * so a crash can never leave the cursor ahead of the stored messages. Null: sync stopped keeping the channel for `selfId`
   * while the page was fetched, so nothing is stored and the cursors stay put.
   */
  ingestSyncPage(channelId: string, page: RawMessage[], direction: 'newer' | 'older', reachedEnd: boolean, selfId: string | null): IngestResult | null {
    let result: IngestResult | null = null;
    this.atomically(() => {
      if (!this.syncable(channelId, selfId)) return;
      result = page.length ? this.ingestMessages(page, ARRIVAL.sync) : { inserted: 0, edited: 0, skipped: 0 };
      const ids = page.map((m) => m.id).sort(compareSnowflakes);
      const cur = syncCursor(this.db, channelId);
      const newest = ids.length && (!cur.newestId || compareSnowflakes(ids.at(-1)!, cur.newestId) > 0) ? ids.at(-1)! : cur.newestId;
      const oldest = ids.length && (!cur.oldestId || compareSnowflakes(ids[0]!, cur.oldestId) < 0) ? ids[0]! : cur.oldestId;
      this.db
        .prepare('UPDATE channels SET sync_newest_id = ?, sync_oldest_id = ?, backfill_complete = ? WHERE id = ?')
        .run(newest, oldest, direction === 'older' && reachedEnd ? 1 : cur.backfillComplete ? 1 : 0, channelId);
    });
    return result;
  }

  /** Global identities; knowing a person alone supplies no server membership or channel access. */
  upsertUsers(users: RawUserPatch[]): void {
    this.db.transaction(() => {
      for (const user of users) upsertUser(this.db, user);
    })();
  }

  /** Server membership facts, including partial updates and READY's user_id references. */
  upsertMembers(guildId: string, members: RawMemberPatch[], mode: MemberPayloadMode = 'snapshot'): void {
    upsertMembers(this.db, guildId, members, mode);
  }

  /** A member left their server. */
  markMemberLeft(guildId: string, userId: string): void {
    markMemberLeft(this.db, guildId, userId, Date.now());
  }

  /** Server roles, from the gateway: they colour and mark members' names. */
  applyRoleChange(c: RoleChange): void {
    applyRoleChange(this.db, c);
  }


}
