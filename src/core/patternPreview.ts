import type { ContentKind } from '@shared/messageContent';
import { keywordRegex, type PatternPreview } from '@shared/keywordPattern';
import { MS_PER_DAY } from '@shared/units';
import type { Db } from './db';
import { inChannelsSql } from './queries/channelScope';
import { containsAnySql } from './queries/messageContent';
import { MESSAGE_TEXT_SQL } from './queries/messageText';
import { displayNameSql } from './queries/names';
import { visibleMessageSql } from './queries/privacy';
import { snippet } from './queries/snippet';

/** How far back the Topics editor's "check the archive" looks: recent enough to be quick, long enough to judge a pattern. */
const PREVIEW_DAYS = 30;
/** Messages tested at most, newest first; bounds the check on a very busy archive. */
const PREVIEW_SCAN_MAX = 20_000;
/** Matches listed; the count covers all of them. */
const PREVIEW_HITS = 25;

/**
 * What a pattern would match among recent archived messages in a topic's scope (null = every archived channel;
 * a channel includes its threads; `contains` null = any message). Throws on a bad regex, as saving would.
 */
export function previewPattern(db: Db, pattern: string, channelIds: string[] | null, contains: ContentKind[] | null, now = Date.now()): PatternPreview {
  const sinceTs = now - PREVIEW_DAYS * MS_PER_DAY;
  const re = keywordRegex(pattern);
  if (!re) return { hits: [], matched: 0, scanned: 0, sinceTs };
  const scope = channelIds ? inChannelsSql('m.channel_id', channelIds) : null;
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id AS channelId, c.name AS channelName, ${displayNameSql('m.author_id', 'm.channel_id')} AS authorName, m.ts, ${MESSAGE_TEXT_SQL} AS content
       FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.author_id
       WHERE m.ts >= ? AND ${visibleMessageSql('m')} AND ${MESSAGE_TEXT_SQL} != '' ${scope ? `AND ${scope.sql}` : ''} ${contains?.length ? `AND ${containsAnySql(contains)}` : ''}
       ORDER BY m.ts DESC LIMIT ?`,
    )
    .all(sinceTs, ...(scope?.params ?? []), PREVIEW_SCAN_MAX) as { id: string; channelId: string; channelName: string; authorName: string; ts: number; content: string }[];
  const matching = rows.filter((r) => re.test(r.content));
  return {
    hits: matching.slice(0, PREVIEW_HITS).map((r) => ({ messageId: r.id, channelId: r.channelId, channelName: r.channelName, authorName: r.authorName, ts: r.ts, text: snippet(r.content, re) })),
    matched: matching.length,
    scanned: rows.length,
    sinceTs,
  };
}
