// Asks Jev which earlier message in the channel a message continues, for the chooser's close calls.
import { cutText } from '@shared/text';
import { MS_PER_MIN } from '@shared/units';
import { answerValue, type DecisionProvider } from '../ai/decisions';
import type { Db } from '../db';
import { queryMatch, queryRequest } from '../jev/queries';
import { plainNameSql } from '../queries/names';

export const PARENT_QUERY = 'conversations.parent';
/** Characters of each message Jev reads: enough for most chat lines, while twenty-one messages stay a small request. */
export const JEV_TEXT_CHARS = 300;
export const NO_PARENT = 'none';

export interface AskedMessage { id: string; ts: number; author: string; text: string }

/** Jev's pick: a candidate's id or null (none of them), its probability, and whether it meets the query's condition to link. */
export interface JevPick { parentId: string | null; probability: number; links: boolean }

/** Author names, times and text of stored messages, by id. */
export function askedMessages(db: Db, ids: readonly string[]): Map<string, AskedMessage> {
  const rows = db.prepare(`SELECT m.id, m.ts, ${plainNameSql('m.author_id')} AS author, m.content AS text FROM messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as AskedMessage[];
  return new Map(rows.map((r) => [r.id, r]));
}

const line = (m: AskedMessage): string => `${m.author}: ${cutText(m.text, JEV_TEXT_CHARS)}`;
const minutesBefore = (m: AskedMessage, c: AskedMessage): string => `${Math.round((m.ts - c.ts) / MS_PER_MIN)} min before`;

/**
 * Asks about `message` among `candidates`: the channel's messages just before it, oldest first. Each is a numbered option
 * carrying its own text, so Jev weighs the lines themselves. Null when Jev gave no usable answer. `admit` runs before each send.
 */
export async function askParent(
  jev: DecisionProvider, message: AskedMessage, candidates: readonly AskedMessage[], admit?: () => void, signal?: AbortSignal,
): Promise<{ pick: JevPick | null; costUsd: number | null }> {
  const names = candidates.map((_, i) => String(i + 1));
  const options = candidates.map((c, i) => ({ name: names[i]!, description: `(${minutesBefore(message, c)}) ${line(c)}` }));
  const question = queryRequest(PARENT_QUERY, { options: [...options, { name: NO_PARENT, description: '`message` clearly starts a new topic, unrelated to every earlier line' }] });
  const state = { message: line(message), earlier: options.map((o) => `${o.name}. ${o.description}`) };
  const r = await jev.decide({ state, questions: { parent: question }, ...(admit ? { admit } : {}), ...(signal ? { signal } : {}) });
  const a = r.answers.parent;
  if (!a || a.type !== 'choice') return { pick: null, costUsd: r.costUsd };
  const index = names.indexOf(a.choice);
  if (index < 0 && a.choice !== NO_PARENT) return { pick: null, costUsd: r.costUsd };
  const probability = answerValue(a).value;
  const parentId = index < 0 ? null : candidates[index]!.id;
  return { pick: { parentId, probability, links: parentId !== null && queryMatch(PARENT_QUERY, a, names) !== null }, costUsd: r.costUsd };
}
