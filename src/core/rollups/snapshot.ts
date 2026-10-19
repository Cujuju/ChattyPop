import type { Db } from '../db';
import { metadataAffects } from './metadata';
import { pendingChangesSql } from './changes';

/** Clean tokens are optional optimizations; exact hybrid readers do not wait for one. */
export function rollupSnapshot(db: Db, id: string, scope?: { channelIds?: readonly string[]; firstDay?: string }): string | null {
  if (metadataAffects(db, id)) return null;
  const row = db.prepare(`SELECT m.version, m.zone, m.revision, r.revision AS references_revision, v.revision AS visibility_revision
    FROM rollup_meta m JOIN rollup_reference_state r ON r.singleton = 1
      JOIN rollup_visibility_state v ON v.singleton = 1
    WHERE m.rollup = @rollup AND m.backfill = 0 AND r.ready = 1
      AND NOT EXISTS (SELECT 1 FROM rollup_fold_dirty f WHERE f.rollup = m.rollup
        AND (@channels IS NULL OR f.channel_id IN (SELECT value FROM json_each(@channels))))
      AND NOT ${pendingChangesSql('m.rollup', undefined, undefined, '@first', '@channels')}
      AND NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = m.rollup
        AND (@channels IS NULL OR channel_id IN (SELECT value FROM json_each(@channels)))
        AND (@first IS NULL OR day = '' OR day >= @first))
      AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty WHERE rollup = m.rollup
        AND (@channels IS NULL OR channel_id IN (SELECT value FROM json_each(@channels)))
        AND (@first IS NULL OR last_day >= @first))`)
    .get({ rollup: id, channels: scope?.channelIds ? JSON.stringify(scope.channelIds) : null, first: scope?.firstDay ?? null }) as { version: number; zone: string; revision: number; references_revision: number; visibility_revision: number } | undefined;
  if (!row) return null;
  return `${row.version}:${row.revision}:${row.references_revision}:${row.visibility_revision}:${row.zone}`;
}
