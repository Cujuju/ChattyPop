// A rule's Alert history: its direct matches (keywords, or narrowing alone) over the whole archive, as topics kept
// theirs. Messages older than the rule land read; nothing else runs for them.
import type { ContentKind } from '@shared/messageContent';
import { ruleKind } from '@shared/ruleKinds';
import type { TextMessage } from '../arrival';
import type { Db } from '../db';
import { inChannelsSql } from '../queries/channelScope';
import { containsAnySql, contentColumnsSql, kindsOfRow } from '../queries/messageContent';
import { TEXT_MESSAGE_COLUMNS } from '../queries/messageText';
import { directMatch, narrowPasses, scopePasses, type CompiledRule, type MessageFacts } from './compile';
import type { Hit } from './hit';

/** One archived message a rule's history matches directly. */
export interface RuleHistoryMatch {
  m: TextMessage;
  hit: Hit;
  contents: ContentKind[];
}

/** Direct history eligible for a plugin action, without reading or writing plugin rows. `matches` scans the archive; the rest is free. */
export interface RuleHistory {
  armedAt: number;
  syncDirect: boolean;
  matches(): RuleHistoryMatch[];
}

/** Whether a rule keeps archive-wide history: it alerts, and matches without Jev on keywords or a narrowing (not everything). */
export function keepsHistory(r: CompiledRule, actionType: string): boolean {
  const narrows = r.spec.narrow.some((p) =>
    ruleKind('filters', p.type)?.narrows?.(p.config) ?? (Array.isArray(p.config) ? p.config.length > 0 : true),
  );
  return (
    r.spec.actions.some((a) => a.type === actionType && ruleKind('actions', a.type)?.history) &&
    !r.builtin &&
    (r.matches.some((p) => !!p.direct) || (r.byNarrow && narrows))
  );
}

/** A compiled rule's history; the archive is read only when `matches` is called. */
export function readHistory(db: Db, r: CompiledRule, facts: (m: TextMessage) => MessageFacts, actionType: string): RuleHistory {
  // Jev-only rules lose old direct matches; rules matching everything and managed rules keep theirs.
  const syncDirect = keepsHistory(r, actionType) || (!r.matches.some((p) => !!p.direct) && !r.byNarrow && !r.builtin);
  const contentKinds = r.spec.narrow.find((p) => p.type === 'contains')?.config as ContentKind[] | undefined;
  const contains = contentKinds?.length ? contentKinds : null;
  const scope = r.channels ? inChannelsSql('m.channel_id', [...r.channels]) : null;
  type Row = TextMessage & Record<string, unknown>;
  const matches = (): RuleHistoryMatch[] => {
    if (!keepsHistory(r, actionType)) return [];
    const rows = db
      .prepare(
        `SELECT ${TEXT_MESSAGE_COLUMNS}${contains ? `, ${contentColumnsSql(contains)}` : ''} FROM messages m WHERE 1 ${scope ? `AND ${scope.sql}` : ''} ${contains ? `AND ${containsAnySql(contains)}` : ''}`,
      )
      .all(...(scope?.params ?? [])) as Row[];
    return rows.flatMap((m) => {
      const f = facts(m);
      const hit = directMatch(r, f);
      return hit && scopePasses(r, f) && narrowPasses(r, f) ? [{ m, hit, contents: [...kindsOfRow(m, contains ?? [])] }] : [];
    });
  };
  return { armedAt: r.armedAt, syncDirect, matches };
}
