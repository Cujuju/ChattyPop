// Re-runs edited built-in queries on past messages. Stores and acts on answers; old-message alerts become read history.
import { JEV_RERUN_MAX, jevQueryDef, type JevRerunRequest } from '@shared/jevQueries';
import { ruleSubject } from '@shared/rules';
import { LOCAL_ONLY_IDS_SQL } from '../channelPolicy';
import type { Db } from '../db';
import { inChannelOrChildSql } from '../queries/channelScope';
import { MESSAGE_TEXT_SQL, TEXT_MESSAGE_COLUMNS, assertRange } from '../queries/messageText';
import type { TextMessage } from '../arrival';
import { loadRule, ruleRows } from '../rules/ruleStore';
import { CLASSES } from './classes';
import { NOTABLE_QUERY, NOTABLE_SUBJECT } from './notable';
import { TAG_QUERY, TAG_SUBJECT } from './tags';
import { QUERY } from './questions';

/** The jev_judgments subjects a per-message query answers under; the meaning query covers every rule matching by meaning. */
export function rerunSubjects(db: Db, queryId: string): Set<string> {
  const fixed: Record<string, string> = {
    [NOTABLE_QUERY]: NOTABLE_SUBJECT,
    [TAG_QUERY]: TAG_SUBJECT,
    ...Object.fromEntries(CLASSES.map((c) => [c.query, c.subject])),
  };
  if (queryId === QUERY.meaning) {
    // A rule's own question takes precedence over its meaning (ruleQuestion), so those rules aren't asked the meaning query.
    return new Set(
      ruleRows(db).flatMap((row) => {
        const m = loadRule(row).spec?.match;
        return m?.some((p) => p.type === 'meaning') ? [ruleSubject(row.id)] : [];
      }),
    );
  }
  const subject = fixed[queryId] ?? jevQueryDef(queryId)?.subject;
  if (!subject || !jevQueryDef(queryId)?.perMessage)
    throw new Error('Only a per-message query can run on past messages.');
  return new Set([subject]);
}

/**
 * Messages with text in the range, newest first, from one channel and its threads or every archived channel; never a
 * local-AI-only channel's. At most JEV_RERUN_MAX.
 */
export function rerunMessages(db: Db, req: JevRerunRequest): TextMessage[] {
  assertRange(req.fromTs, req.toTs);
  const scope =
    req.channelId === null
      ? 'm.channel_id IN (SELECT id FROM channels WHERE opted_in = 1 OR parent_id IN (SELECT id FROM channels WHERE opted_in = 1))'
      : inChannelOrChildSql('@channel');
  return db
    .prepare(
      `SELECT ${TEXT_MESSAGE_COLUMNS} FROM messages m
       WHERE ${MESSAGE_TEXT_SQL} != '' AND m.ts >= @from AND m.ts < @to AND ${scope}
         AND m.channel_id NOT IN (${LOCAL_ONLY_IDS_SQL})
       ORDER BY m.ts DESC LIMIT @limit`,
    )
    .all({ channel: req.channelId, from: req.fromTs, to: req.toTs, limit: JEV_RERUN_MAX }) as TextMessage[];
}
