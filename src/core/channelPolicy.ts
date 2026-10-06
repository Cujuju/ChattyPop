// Per-channel policy set from the channel list: local-AI-only, and a text tier overriding the global one.
// A thread follows its parent channel's policy.
import type { TextTier } from '@shared/settings';
import type { Db } from './db';
import type { PluginDb } from './plugins/pluginDb';
import { THREAD_KINDS_SQL } from './queries/channelScope';

/** Each channel's effective policy: its own, else (for a thread) its parent's. */
const EFFECTIVE = `SELECT c.id,
         MAX(c.local_ai_only, COALESCE(CASE WHEN c.kind IN (${THREAD_KINDS_SQL}) THEN p.local_ai_only END, 0)) AS localOnly,
         COALESCE(c.text_tier, CASE WHEN c.kind IN (${THREAD_KINDS_SQL}) THEN p.text_tier END) AS textTier
       FROM channels c LEFT JOIN channels p ON p.id = c.parent_id`;

/** SQL: ids of channels (with their threads) whose messages may only go to a local model. */
export const LOCAL_ONLY_IDS_SQL = `SELECT id FROM (${EFFECTIVE}) WHERE localOnly = 1`;

/** SQL filter for hosted-model eligibility. Apply per message channel; threads may have stricter policies than their parents. */
export const hostedMayReadSql = (channelColumn: string): string => `${channelColumn} NOT IN (${LOCAL_ONLY_IDS_SQL})`;

/** Channels (with their threads) whose messages may only go to a local model. */
export function localOnlyChannelIds(db: PluginDb): Set<string> {
  return new Set(db.prepare(LOCAL_ONLY_IDS_SQL).pluck().all() as string[]);
}

export function isLocalOnly(db: PluginDb, channelId: string): boolean {
  return db.prepare(`SELECT 1 FROM (${EFFECTIVE}) WHERE id = ? AND localOnly = 1`).get(channelId) !== undefined;
}

/** Throws when the channel is local-AI-only, so Jev (hosted) may not read its messages. */
export function assertHostedMayRead(db: PluginDb, channelId: string): void {
  if (isLocalOnly(db, channelId)) throw new Error('This channel is set to local AI only, so Jev (hosted) may not read it.');
}

/** Channels whose text tier differs from the global one, with the tier they use. */
export function textTierOverrides(db: Db): Map<string, TextTier> {
  const rows = db.prepare(`SELECT id, textTier FROM (${EFFECTIVE}) WHERE textTier IS NOT NULL`).all() as { id: string; textTier: TextTier }[];
  return new Map(rows.map((r) => [r.id, r.textTier]));
}
