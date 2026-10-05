import { MESSAGE_FLAG } from '@shared/components';
import type { ChannelInfo, ChannelPolicy, IngestResult, SyncState } from '@shared/contract';
import {
  compareSnowflakes,
  snowflakeArg,
  snowflakeToMs,
  type RawChannel,
  type RawGuild,
  type RawMember,
  type RawMessage,
  type RawMessageUpdate,
  type RawPrivateChannel,
  type RawThread,
  type RawUser,
} from '@shared/discord';
import { parseRawJson, type Db } from './db';
import { deriveMessage, refreshStoredAttachments } from './derive/deriveMessage';
import { guildOf, markMemberLeft, putMember, upsertMembers, upsertUser } from './people';
import {
  PRIVATE_KINDS_SQL,
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
import { addedTextArrival, textMessage, textedLinkCount } from './queries/messageText';
import { applyReactionEvent, type ReactionEvent } from './reactions';
import { ARRIVAL, type Arrival, type Arrived, type TextMessage } from './arrival';

/** Archive reads/writes. All message mutation goes through here so edits and deletes are never lost. */
export class Archive {
  private readonly optedIn = new Set<string>();

  constructor(
    private readonly db: Db,
    /** Sees every new or changed message text (topics, rules), with how and when it arrived. */
    private readonly onText: (m: TextMessage, arrived: Arrived) => void = () => {},
    /** Sees a message whose links gained text after it arrived (Discord's preview came later); its own text is unchanged. */
    private readonly onLinkedText: (m: TextMessage, arrived: Arrived) => void = () => {},
    /** Sees a message stored or updated (embeds arrive by update): the images it shows may be new. */
    private readonly onShown: (messageId: string) => void = () => {},
  ) {
    this.loadOptedIn();
  }

  /** The opted-in channels as the database holds them (the in-memory mirror every ingest checks). */
  private loadOptedIn(): void {
    this.optedIn.clear();
    for (const r of this.db.prepare('SELECT id FROM channels WHERE opted_in = 1').all() as { id: string }[]) this.optedIn.add(r.id);
  }

  /** Runs `fn` as one transaction: all of its writes or none. A rollback also undoes opt-ins it made in memory. */
  atomically<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (err) {
      this.loadOptedIn();
      throw err;
    }
  }

  upsertGuilds(guilds: RawGuild[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO guilds (id, name, icon, features) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, features = COALESCE(excluded.features, guilds.features)`,
    );
    this.db.transaction(() => guilds.forEach((g) => stmt.run(g.id, g.name, g.icon ?? null, g.features ? JSON.stringify(g.features) : null)))();
  }

  upsertChannels(guildId: string, channels: RawChannel[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO channels (id, guild_id, name, kind, parent_id, position, overwrites) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id, position = excluded.position,
         overwrites = COALESCE(excluded.overwrites, channels.overwrites)`,
    );
    this.db.transaction(() =>
      channels.forEach((c) =>
        stmt.run(c.id, guildId, c.name, c.type, c.parent_id ?? null, c.position ?? null, c.permission_overwrites ? JSON.stringify(c.permission_overwrites) : null),
      ),
    )();
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

  /**
   * Stores threads whose parent channel is archived; a thread is archived exactly when its parent is.
   * Threads of other channels are ignored. Returns the stored threads that have messages left to sync:
   * activity newer than the synced range, or backfill unfinished inside the window starting at `backfillFromMs`.
   */
  upsertThreads(threads: RawThread[], backfillFromMs: number): string[] {
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
        const s = this.syncState(t.id);
        const newer = t.last_message_id && (!s.newestId || compareSnowflakes(t.last_message_id, s.newestId) > 0);
        const backfillLeft = !s.backfillComplete && (!s.oldestId || snowflakeToMs(s.oldestId) > backfillFromMs);
        if (newer || (backfillLeft && t.last_message_id)) stale.push(t.id);
      }
    })();
    return stale;
  }

  channelInfo(channelId: string): ChannelInfo | null {
    const r = this.db.prepare('SELECT kind, guild_id AS guildId FROM channels WHERE id = ?').get(channelId) as ChannelInfo | undefined;
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
   * their parent's thread discovery. `dmsOnly`: just the account's DMs, once READY names it.
   */
  optedInChannels(selfId: string | null, dmsOnly = false): string[] {
    const kinds = dmsOnly ? `AND c.kind IN (${PRIVATE_KINDS_SQL})` : '';
    return (
      this.db.prepare(`SELECT c.id FROM channels c WHERE ${syncedChannelSql('c')} AND c.kind NOT IN (${THREAD_KINDS_SQL}) ${kinds}`).all({ self: selfId ?? '' }) as {
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

  /**
   * Inserts new messages; for known ones whose content changed, keeps the prior text as a revision. `via`: how they
   * reached ChattyPop (only gateway arrivals can be live); a message keeps the way it first arrived.
   */
  ingestMessages(messages: RawMessage[], via: Arrival): IngestResult {
    const result: IngestResult = { inserted: 0, edited: 0, skipped: 0 };
    const getMsg = this.db.prepare('SELECT content, edited_ts, pruned_at FROM messages WHERE id = ?');
    const insert = this.db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, edited_ts, content, raw_json, arrived_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    this.db.transaction(() => {
      for (const m of messages) {
        if (!this.optedIn.has(m.channel_id)) {
          result.skipped++;
          continue;
        }
        upsertUser(this.db, m.author);
        if (m.member && typeof m.member === 'object') putMember(this.db, guildOf(this.db, m.channel_id), m.author.id, m.member as RawMember, snowflakeToMs(m.id));
        const existing = getMsg.get(m.id) as { content: string; edited_ts: number | null; pruned_at: number | null } | undefined;
        // Retention removed this text on purpose; a re-fetch or edit must not bring it back.
        if (existing?.pruned_at) continue;
        const changed = !existing || existing.content !== m.content;
        const texted = changed ? 0 : textedLinkCount(this.db, m.id);
        const editedTs = m.edited_timestamp ? Date.parse(m.edited_timestamp) : null;
        if (!existing) {
          insert.run(m.id, m.channel_id, m.author.id, snowflakeToMs(m.id), editedTs, m.content, JSON.stringify(m), via);
          result.inserted++;
        } else if (existing.content !== m.content) {
          this.reviseContent(m.id, existing, m.content, editedTs, JSON.stringify(m), now);
          result.edited++;
        } else refreshStoredAttachments(this.db, m);
        // Derived first: matching reads the message's attachments and links.
        deriveMessage(this.db, m, m.author.id);
        // Before matching: image text still to come is pending when rules look.
        this.onShown(m.id);
        if (changed) this.onText(this.stored(m.id), { via, at: now, edit: !!existing });
        else this.noteLinkedText(m.id, texted, now);
      }
    })();
    return result;
  }

  /** Applies a partial MESSAGE_UPDATE (a gateway event): content changes become revisions; other fields merge into raw_json. */
  applyUpdate(u: RawMessageUpdate): void {
    if (!this.optedIn.has(u.channel_id)) return;
    const row = this.db.prepare('SELECT author_id, content, edited_ts, raw_json, pruned_at FROM messages WHERE id = ?').get(u.id) as
      { author_id: string; content: string; edited_ts: number | null; raw_json: string | Buffer | null; pruned_at: number | null } | undefined;
    if (!row) {
      if (u.author && typeof u.content === 'string' && u.timestamp) this.ingestMessages([u as RawMessage], ARRIVAL.gateway);
      return;
    }
    if (row.pruned_at) return;
    const mergedObj = { ...(parseRawJson<object>(row.raw_json) ?? {}), ...u };
    const merged = JSON.stringify(mergedObj);
    const editedTs = u.edited_timestamp ? Date.parse(u.edited_timestamp) : row.edited_ts;
    this.db.transaction(() => {
      const edited = typeof u.content === 'string' && u.content !== row.content ? u.content : null;
      const texted = edited === null ? textedLinkCount(this.db, u.id) : 0;
      if (edited !== null) this.reviseContent(u.id, row, edited, editedTs, merged, Date.now());
      else this.db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(merged, u.id);
      deriveMessage(this.db, mergedObj, row.author_id); // before matching, which reads attachments and links
      this.onShown(u.id);
      if (edited !== null) this.onText(this.stored(u.id), { via: ARRIVAL.gateway, at: Date.now(), edit: true });
      else this.noteLinkedText(u.id, texted, Date.now());
    })();
  }

  /** A message just written, as matching reads it. */
  private stored(id: string): TextMessage {
    const m = textMessage(this.db, id);
    if (!m) throw new Error(`Message ${id} was not stored.`);
    return m;
  }

  /** After a re-derive that left a message's own text alone: passes it on when more of its links now have text than `texted`. */
  private noteLinkedText(id: string, texted: number, at: number): void {
    if (textedLinkCount(this.db, id) > texted) this.onLinkedText(this.stored(id), addedTextArrival(this.db, id, at));
  }

  /** Reaction events on an archived message (see reactions.ts); `selfId` tells the owner's own apart. */
  applyReaction(t: string, d: ReactionEvent, selfId: string | null): boolean {
    return this.optedIn.has(d.channel_id) && applyReactionEvent(this.db, t, d, selfId);
  }

  /**
   * After re-fetching a contiguous window, a stored message inside it that Discord no longer returned was deleted
   * while ChattyPop wasn't watching. Retention-pruned rows count too: they were fetched before, so absence means deletion.
   * Ephemeral messages (only the owner saw them, live) are never in history, so absence says nothing about them.
   */
  reconcileDeletes(channelId: string, seenIds: string[], sinceTs: number, untilTs: number, at: number): number {
    if (!this.optedIn.has(channelId)) return 0;
    const seen = new Set(seenIds);
    const ephemeral = `COALESCE(${rawJsonSql('$.flags', '')}, 0) & ${MESSAGE_FLAG.ephemeral}`;
    const stored = this.db
      .prepare(`SELECT id FROM messages WHERE channel_id = ? AND ts >= ? AND ts <= ? AND deleted_at IS NULL AND ${ephemeral} = 0`)
      .all(channelId, sinceTs, untilTs) as { id: string }[];
    const gone = stored.filter((r) => !seen.has(r.id));
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
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?').get(channelId) as { count: number };
    const c = this.db.prepare('SELECT sync_oldest_id AS o, sync_newest_id AS n, backfill_complete AS done FROM channels WHERE id = ?').get(channelId) as
      { o: string | null; n: string | null; done: number } | undefined;
    return { channelId, oldestId: c?.o ?? null, newestId: c?.n ?? null, count, backfillComplete: c?.done === 1 };
  }

  /**
   * Stores one page fetched by sync and extends the synced range in the same transaction,
   * so a crash can never leave the cursor ahead of the stored messages.
   */
  ingestSyncPage(channelId: string, page: RawMessage[], direction: 'newer' | 'older', reachedEnd: boolean): IngestResult {
    let result: IngestResult = { inserted: 0, edited: 0, skipped: 0 };
    this.db.transaction(() => {
      if (page.length) result = this.ingestMessages(page, ARRIVAL.sync);
      const ids = page.map((m) => m.id).sort(compareSnowflakes);
      const cur = this.syncState(channelId);
      const newest = ids.length && (!cur.newestId || compareSnowflakes(ids.at(-1)!, cur.newestId) > 0) ? ids.at(-1)! : cur.newestId;
      const oldest = ids.length && (!cur.oldestId || compareSnowflakes(ids[0]!, cur.oldestId) < 0) ? ids[0]! : cur.oldestId;
      this.db
        .prepare('UPDATE channels SET sync_newest_id = ?, sync_oldest_id = ?, backfill_complete = ? WHERE id = ?')
        .run(newest, oldest, direction === 'older' && reachedEnd ? 1 : cur.backfillComplete ? 1 : 0, channelId);
    })();
    return result;
  }

  /** Server nicknames from member events (GUILD_MEMBERS_CHUNK, GUILD_MEMBER_UPDATE, the member list). */
  upsertMembers(guildId: string, members: RawMember[]): void {
    upsertMembers(this.db, guildId, members);
  }

  /** A member left their server. */
  markMemberLeft(guildId: string, userId: string): void {
    markMemberLeft(this.db, guildId, userId, Date.now());
  }

  /** Server roles, from the gateway: they colour and mark members' names. */
  applyRoleChange(c: RoleChange): void {
    applyRoleChange(this.db, c);
  }

  private reviseContent(
    id: string,
    prior: { content: string; edited_ts: number | null },
    content: string,
    editedTs: number | null,
    raw: string,
    now: number,
  ): void {
    this.db
      .prepare('INSERT OR IGNORE INTO message_revisions (message_id, seen_at, edited_ts, content) VALUES (?, ?, ?, ?)')
      .run(id, now, prior.edited_ts, prior.content);
    this.db.prepare('UPDATE messages SET content = ?, edited_ts = ?, raw_json = ? WHERE id = ?').run(content, editedTs, raw, id);
  }
}
