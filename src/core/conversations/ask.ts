// Asks Jev which of a message's likeliest earlier messages it continues, for the chooser's close calls.
import { cutText } from '@shared/text';
import { answerValue, type DecisionProvider } from '../ai/decisions';
import type { Db } from '../db';
import { queryMatch, queryRequest } from '../jev/queries';
import { plainNameSql } from '../queries/names';

export const PARENT_QUERY = 'conversations.parent';
/** Candidates Jev sees: the chooser's likeliest five (the Jev score reports how often the answer is among them). */
export const JEV_CANDIDATES = 5;
/** Characters of each message Jev reads: enough for most chat lines, while six messages stay a small request. */
export const JEV_TEXT_CHARS = 300;
export const NO_PARENT = 'none';

export interface AskedMessage { id: string; author: string; text: string }

/** Jev's pick: a candidate's id or null (none of them), its probability, and whether it meets the query's condition to link. */
export interface JevPick { parentId: string | null; probability: number; links: boolean }

/** Author names and text of stored messages, by id. */
export function askedMessages(db: Db, ids: readonly string[]): Map<string, AskedMessage> {
  const rows = db.prepare(`SELECT m.id, ${plainNameSql('m.author_id')} AS author, m.content AS text FROM messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as AskedMessage[];
  return new Map(rows.map((r) => [r.id, r]));
}

const line = (m: AskedMessage): string => `${m.author}: ${cutText(m.text, JEV_TEXT_CHARS)}`;

/** Asks about `message` among `candidates` (oldest first); null when Jev gave no usable answer. `admit` runs before each send. */
export async function askParent(
  jev: DecisionProvider, message: AskedMessage, candidates: readonly AskedMessage[], admit?: () => void, signal?: AbortSignal,
): Promise<{ pick: JevPick | null; costUsd: number | null }> {
  const names = candidates.map((_, i) => String(i + 1));
  const question = queryRequest(PARENT_QUERY, { options: [...names.map((name) => ({ name, description: '' })), { name: NO_PARENT, description: '`message` starts something new' }] });
  const state = { message: line(message), earlier: candidates.map((c, i) => `${names[i]}. ${line(c)}`) };
  const r = await jev.decide({ state, questions: { parent: question }, ...(admit ? { admit } : {}), ...(signal ? { signal } : {}) });
  const a = r.answers.parent;
  if (!a || a.type !== 'choice') return { pick: null, costUsd: r.costUsd };
  const index = names.indexOf(a.choice);
  if (index < 0 && a.choice !== NO_PARENT) return { pick: null, costUsd: r.costUsd };
  const probability = answerValue(a).value;
  const parentId = index < 0 ? null : candidates[index]!.id;
  return { pick: { parentId, probability, links: parentId !== null && queryMatch(PARENT_QUERY, a, names) !== null }, costUsd: r.costUsd };
}
