// Frozen pre-fix permission projection for parity and real-scale cost comparisons.
import type { SavedChannelAccess } from '@shared/savedMessages';
import { DM_CHANNEL_TYPES, THREAD_CHANNEL_TYPES } from '@shared/discord';
import { PRIVATE_THREAD_TYPE, PERMISSIONS, can } from '@shared/permissions';
import type { Db } from '../src/core/db';
import { visibleChannelSql } from '../src/core/queries/privacy';
import { accessOf, memberFacts } from '../src/core/queries/mentions';
import type { RuleMatcher } from '../src/core/rules/matcher';
import type { RawUser } from '@shared/discord';
import type { TextMessage } from '../src/core/arrival';
import { MEANING_LOOKBACK_MS } from '../src/core/jev/messageJudge';
import { TEXT_MESSAGE_COLUMNS } from '../src/core/queries/messageText';

/** Frozen pre-fix setSelf catch-up body; calls the same live match/judgment functions. */
export function legacySetSelf(matcher: RuleMatcher, db: Db, user: RawUser): void {
  matcher['self'] = user;
  const since = Date.now() - MEANING_LOOKBACK_MS;
  const judged = matcher['judge'].judgedSince(since);
  const recent = db.prepare(`SELECT ${TEXT_MESSAGE_COLUMNS} FROM messages m WHERE m.ts >= ? ORDER BY m.ts`).all(since) as TextMessage[];
  const due: Parameters<RuleMatcher['judgeAll']>[0] = [];
  for (const m of recent) {
    const eventId = matcher['engine'].nextEventId();
    const fired = new Set<string>();
    const ctx = { live: false, edit: false, mayAct: (type: string) => fired.has(type) };
    const ask = matcher['evaluate'](m, ctx, (r, hit) => {
      if (matcher['hit'](r, m, hit, null, eventId)) for (const a of r.spec.actions) fired.add(a.type);
    });
    const req = m.content ? matcher['request'](eventId, m, ask, ctx, judged) : null;
    if (req) due.push({ m, req });
    else matcher['engine'].kinds.settle({ eventId, m, answers: null });
  }
  void matcher['judgeAll'](due);
}

export function legacySavedWritableChannels(db: Db, accountId: string): SavedChannelAccess[] {
  const channels = db.prepare(`SELECT id, guild_id AS guildId, parent_id AS parentId, kind, account_id AS accountId, closed_at AS closedAt FROM channels WHERE ${visibleChannelSql('id')}`).all() as { id: string; guildId: string; parentId: string | null; kind: number; accountId: string | null; closedAt: number | null }[];
  return channels.flatMap<SavedChannelAccess>((c) => {
    if (DM_CHANNEL_TYPES.has(c.kind)) return c.accountId === accountId && c.closedAt === null ? [{ channelId: c.id, guildId: null, parentId: null, privateThread: false }] : [];
    const thread = THREAD_CHANNEL_TYPES.has(c.kind), access = accessOf(db, c.guildId, thread && c.parentId ? c.parentId : c.id, thread);
    return can(access, accountId, memberFacts(db, c.guildId, accountId), PERMISSIONS.READ_MESSAGE_HISTORY) ? [{ channelId: c.id, guildId: c.guildId, parentId: thread ? c.parentId : null, privateThread: c.kind === PRIVATE_THREAD_TYPE }] : [];
  });
}
