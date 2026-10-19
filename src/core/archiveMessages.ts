import { MESSAGE_FLAG } from '@shared/components';
import type { IngestResult } from '@shared/contract';
import type { NoteArchiveChange } from '@shared/archiveChanges';
import { compareSnowflakes, snowflakeToMs, type RawMessage, type RawMessageUpdate, type RawMember } from '@shared/discord';
import { parseRawJson, rawJsonText, type Db } from './db';
import { messageChangeKinds, utcDay } from './archiveChangeSource';
import { deriveMessage } from './derive/deriveMessage';
import { queueConversationLinks, queueMessageRelink } from './conversations/store';
import { mergeFullPayload, olderVersion } from './messageVersion';
import { guildOf, putMember, upsertUser, type UserMergeMode } from './people';
import { addedTextArrival, textMessage, textedLinkCount } from './queries/messageText';
import { ARRIVAL, type Arrival, type Arrived, type TextMessage } from './arrival';

/** Message writes, derived media and precise notifications share one mutation boundary. */
export class ArchiveMessages {
  constructor(
    private readonly db: Db,
    private readonly optedIn: (channelId: string) => boolean,
    private readonly onText: (m: TextMessage, arrived: Arrived) => void,
    private readonly onLinkedText: (m: TextMessage, arrived: Arrived) => void,
    private readonly onShown: (messageId: string) => void,
    private readonly onChange: NoteArchiveChange,
  ) {}

  /**
   * Inserts messages and retains changed text as revisions; a copy older than the stored edit changes nothing, and a
   * current one refreshes the stored payload. Arrival source remains the first source; only gateway arrivals can be live.
   */
  ingestMessages(messages: RawMessage[], via: Arrival): IngestResult {
    const changes: Parameters<NoteArchiveChange>[] = [];
    const result: IngestResult = { inserted: 0, edited: 0, skipped: 0 };
    const getMsg = this.db.prepare('SELECT content, edited_ts, raw_json, pruned_at FROM messages WHERE id = ?');
    const insert = this.db.prepare(
      'INSERT INTO messages (id, channel_id, author_id, ts, edited_ts, content, raw_json, arrived_via, ephemeral) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const refresh = this.db.prepare('UPDATE messages SET edited_ts = ?, raw_json = ? WHERE id = ?');
    const now = Date.now();
    const newestBefore = new Map<string, string | undefined>();
    this.db.transaction(() => {
      for (const m of messages) {
        if (!this.optedIn(m.channel_id)) {
          result.skipped++;
          continue;
        }
        upsertUser(this.db, m.author);
        const guildId = guildOf(this.db, m.channel_id);
        const seenAt = snowflakeToMs(m.id);
        if (m.member && typeof m.member === 'object') putMember(this.db, guildId, m.author.id, m.member as RawMember, seenAt);
        this.ingestMentions(m.mentions, guildId, seenAt, via === ARRIVAL.gateway ? 'merge' : 'keep');
        const existing = getMsg.get(m.id) as
          { content: string; edited_ts: number | null; raw_json: string | Buffer | null; pruned_at: number | null } | undefined;
        // Retention removed this text on purpose; a re-fetch or edit must not bring it back.
        if (existing?.pruned_at) continue;
        const editedTs = m.edited_timestamp ? Date.parse(m.edited_timestamp) : null;
        // Fetched before an edit the archive already holds (a history page delivered late).
        if (existing && olderVersion(editedTs, existing.edited_ts)) continue;
        if (!newestBefore.has(m.channel_id)) newestBefore.set(m.channel_id, this.db.prepare('SELECT id FROM messages WHERE channel_id = ? ORDER BY ts DESC, id DESC LIMIT 1').pluck().get(m.channel_id) as string | undefined);
        const newest = newestBefore.get(m.channel_id);
        const appendOnly = !existing && (!newest || compareSnowflakes(m.id, newest) > 0);
        const changed = !existing || existing.content !== m.content;
        let payloadChanged = !existing;
        const texted = changed ? 0 : textedLinkCount(this.db, m.id);
        if (!existing) {
          const ephemeral = typeof m.flags === 'number' && (m.flags & MESSAGE_FLAG.ephemeral) !== 0 ? 1 : 0;
          insert.run(m.id, m.channel_id, m.author.id, snowflakeToMs(m.id), editedTs, m.content, JSON.stringify(m), via, ephemeral);
          queueConversationLinks(this.db, m.channel_id, snowflakeToMs(m.id));
          result.inserted++;
        } else {
          const storedJson = rawJsonText(existing.raw_json);
          const raw = JSON.stringify(mergeFullPayload(storedJson ? (JSON.parse(storedJson) as object) : null, m));
          payloadChanged = raw !== storedJson || editedTs !== existing.edited_ts;
          if (changed) {
            this.reviseContent(m.id, existing, m.content, editedTs, raw, now);
            result.edited++;
          } else if (raw !== storedJson || editedTs !== existing.edited_ts) refresh.run(editedTs, raw, m.id); // unchanged rows keep their compression
        }
        // Derived first: matching reads the message's attachments and links.
        const derived = deriveMessage(this.db, m, m.author.id);
        const seq = !existing ? this.db.prepare('SELECT seq FROM messages WHERE id = ?').pluck().get(m.id) as number : undefined;
        if (payloadChanged) {
          const kinds = messageChangeKinds(existing ? parseRawJson<object>(existing.raw_json) : null, m, derived.kinds);
          changes.push([m.channel_id, kinds, { insertOnly: appendOnly && derived.insertOnly, seq, day: utcDay(snowflakeToMs(m.id)) }]);
          if (kinds.includes('links')) derived.relatedLinks.forEach(({ channelId, day }) => changes.push([channelId, ['links'], { day }]));
        }
        // Before matching: image text still to come is pending when rules look.
        this.onShown(m.id);
        if (changed) this.onText(this.stored(m.id), { via, at: now, edit: !!existing });
        else this.noteLinkedText(m.id, texted, now);
      }
    })();
    changes.filter(([, kinds]) => kinds.length).forEach((c) => this.onChange(...c));
    return result;
  }

  /** Applies a partial MESSAGE_UPDATE (a gateway event): content changes become revisions; other fields merge into raw_json. */
  applyUpdate(u: RawMessageUpdate): void {
    if (!this.optedIn(u.channel_id)) return;
    const row = this.db.prepare('SELECT author_id, content, edited_ts, raw_json, pruned_at FROM messages WHERE id = ?').get(u.id) as
      { author_id: string; content: string; edited_ts: number | null; raw_json: string | Buffer | null; pruned_at: number | null } | undefined;
    if (!row) {
      if (u.author && typeof u.content === 'string' && u.timestamp) this.ingestMessages([u as RawMessage], ARRIVAL.gateway);
      return;
    }
    let kinds: ReturnType<typeof deriveMessage> | undefined;
    this.db.transaction(() => {
      // Identity facts survive pruning; one update commits its author and every mention together.
      if (u.author) upsertUser(this.db, u.author);
      this.ingestMentions(u.mentions, guildOf(this.db, u.channel_id), snowflakeToMs(u.id));
      if (row.pruned_at) return;
      // A copy that names its version (null: unedited) and predates the stored edit is stale; one without it is a partial update.
      if (u.edited_timestamp !== undefined && olderVersion(u.edited_timestamp ? Date.parse(u.edited_timestamp) : null, row.edited_ts)) return;
      const mergedObj = { ...(parseRawJson<object>(row.raw_json) ?? {}), ...u };
      const merged = JSON.stringify(mergedObj);
      const editedTs = u.edited_timestamp ? Date.parse(u.edited_timestamp) : row.edited_ts;
      const edited = typeof u.content === 'string' && u.content !== row.content ? u.content : null;
      const texted = edited === null ? textedLinkCount(this.db, u.id) : 0;
      if (edited !== null) this.reviseContent(u.id, row, edited, editedTs, merged, Date.now());
      // Same text: the version still advances, so a snapshot older than this update stays stale.
      else this.db.prepare('UPDATE messages SET edited_ts = ?, raw_json = ? WHERE id = ?').run(editedTs, merged, u.id);
      kinds = deriveMessage(this.db, mergedObj, row.author_id); // before matching, which reads attachments and links
      this.onShown(u.id);
      if (edited !== null) this.onText(this.stored(u.id), { via: ARRIVAL.gateway, at: Date.now(), edit: true });
      else this.noteLinkedText(u.id, texted, Date.now());
    })();
    if (kinds) {
      const before = parseRawJson<object>(row.raw_json) ?? {};
      const changed = messageChangeKinds(before, { ...before, ...u }, kinds.kinds);
      if (changed.length) this.onChange(u.channel_id, changed, { day: utcDay(snowflakeToMs(u.id)) });
      if (changed.includes('links')) kinds.relatedLinks.forEach(({ channelId, day }) => this.onChange(channelId, ['links'], { day }));
    }
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

  /** Only called for opted-in messages. A mention alone never proves server membership. */
  private ingestMentions(mentions: RawMessage['mentions'], guildId: string | null, seenAt: number, mode: UserMergeMode = 'merge'): void {
    for (const user of mentions ?? []) {
      upsertUser(this.db, user, mode);
      if (user.member) putMember(this.db, guildId, user.id, user.member, seenAt);
    }
  }

  /** Keeps the prior text as a revision. seen_at, its key, rises per message: edits within one millisecond each get their own. */
  private reviseContent(
    id: string,
    prior: { content: string; edited_ts: number | null },
    content: string,
    editedTs: number | null,
    raw: string,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO message_revisions (message_id, seen_at, edited_ts, content)
         VALUES (@id, MAX(@now, COALESCE((SELECT MAX(seen_at) + 1 FROM message_revisions WHERE message_id = @id), @now)), @editedTs, @content)`,
      )
      .run({ id, now, editedTs: prior.edited_ts, content: prior.content });
    this.db.prepare('UPDATE messages SET content = ?, edited_ts = ?, raw_json = ? WHERE id = ?').run(content, editedTs, raw, id);
    queueMessageRelink(this.db, id);
  }
}
