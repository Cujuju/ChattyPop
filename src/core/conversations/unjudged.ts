import type { Db } from '../db';
import { localOnlyChannelIds } from '../channelPolicy';
import { MS_PER_DAY } from '@shared/units';
import { JUDGE_BELOW, LINK_KIND } from './linker';

/** The owner's choice: new messages and the last thirty days. */
export const JUDGE_LOOKBACK_MS = 30 * MS_PER_DAY;
/** Failed judgments retry daily, bounding repeated provider failures. */
export const JUDGE_RETRY_MS = MS_PER_DAY;
export interface PendingJudgment { id: string; channelId: string; ts: number }

/** Kind and timestamp seek the candidate index; exact exclusion checks still run in the read process. */
export const UNJUDGED_SQL = `SELECT l.message_id AS id, l.channel_id AS channelId, l.ts FROM conversation_links l
  LEFT JOIN conversation_judgments j ON j.message_id = l.message_id
  WHERE l.kind = '${LINK_KIND.inferred}' AND l.confidence < @below AND l.ts >= @since
    AND (j.message_id IS NULL OR j.failed_at < @retry)
    AND l.channel_id NOT IN (SELECT value FROM json_each(@local))
    AND NOT EXISTS (SELECT 1 FROM conversation_marks k WHERE k.message_id = l.message_id)
  ORDER BY l.ts DESC LIMIT @limit`;

export function unjudged(db: Db, now: number, limit: number): PendingJudgment[] {
  return db.prepare(UNJUDGED_SQL).all({ below: JUDGE_BELOW, since: now - JUDGE_LOOKBACK_MS,
    retry: now - JUDGE_RETRY_MS, local: JSON.stringify([...localOnlyChannelIds(db)]), limit }) as PendingJudgment[];
}
