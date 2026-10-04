// Discord's read states as main keeps them (main/discord/readStates.ts): unread mention counts for the sidebar, and a
// DM's last read message and mute end.
import type { ReadStateCount, ReadStateScope } from '@shared/contract';
import type { Db } from '../db';

/**
 * Stores `counts` as `scope` says (ReadStateScope). A field absent from a count keeps the stored value, except after a
 * reset. A row left with nothing to say is dropped.
 */
export function putReadStates(db: Db, counts: ReadStateCount[], scope: ReadStateScope): void {
  const put = db.prepare(
    `INSERT INTO read_states (channel_id, mention_count, ack_id, mute_ends_ms) VALUES (@channel, COALESCE(@mentions, 0), @ack, @mute)
     ON CONFLICT(channel_id) DO UPDATE SET
       mention_count = CASE WHEN @mentionsKnown THEN excluded.mention_count ELSE read_states.mention_count END,
       ack_id = CASE WHEN @ackKnown THEN excluded.ack_id ELSE read_states.ack_id END,
       mute_ends_ms = CASE WHEN @muteKnown THEN excluded.mute_ends_ms ELSE read_states.mute_ends_ms END`,
  );
  const dropEmpty = db.prepare('DELETE FROM read_states WHERE channel_id = ? AND mention_count = 0 AND ack_id IS NULL AND mute_ends_ms IS NULL');
  db.transaction(() => {
    if (scope === 'reset') db.exec('DELETE FROM read_states');
    if (scope === 'replace') {
      const listed = JSON.stringify(counts.map((c) => c.channelId));
      db.prepare('DELETE FROM read_states WHERE channel_id NOT IN (SELECT value FROM json_each(?))').run(listed);
    }
    for (const c of counts) {
      put.run({
        channel: c.channelId,
        mentions: c.mentionCount ?? null,
        mentionsKnown: c.mentionCount !== undefined ? 1 : 0,
        ack: c.ackId ?? null,
        ackKnown: c.ackId !== undefined ? 1 : 0,
        mute: c.muteEndsMs ?? null,
        muteKnown: c.muteEndsMs !== undefined ? 1 : 0,
      });
      dropEmpty.run(c.channelId);
    }
  })();
}
