// Asks Jev which earlier message in the channel a message continues, for the chooser's close calls.
import { cutText } from '@shared/text';
import { MS_PER_MIN } from '@shared/units';
import type { DecisionProvider, Question } from '../ai/decisions';
import type { Db } from '../db';
import { queryRequest, queryStrength } from '../jev/queries';
import { plainNameSql } from '../queries/names';

/** One pick among all candidates. */
export const PARENT_QUERY = 'conversations.parent';
/** One yes/no per candidate: TypeSafe's matching pattern, a narrow question per record. */
export const CONTINUES_QUERY = 'conversations.continues';
/** Where the continues question names its candidate's index in `earlier`. */
export const CANDIDATE_MARK = '{i}';
/** Characters of each message Jev reads: enough for most chat lines, while twenty-one messages stay a small request. */
export const JEV_TEXT_CHARS = 300;
export const NO_PARENT = 'none';
const NO_PARENT_TEXT = '`message` starts a new topic, unrelated to every message in `earlier`';

export interface AskedMessage { id: string; ts: number; author: string; text: string }

/** Jev's answers about one message, per candidate (oldest first). Null where Jev gave no usable answer. */
export interface JevView {
  /** The pick's probability for each candidate. */
  choice: number[] | null;
  /** The pick's probability of "none of them". */
  none: number | null;
  /** How strongly `message` continues each candidate, 0–1: the yes probability (or an owner's score, scaled). */
  continues: (number | null)[];
}

/** Author names, times and text of stored messages, by id. */
export function askedMessages(db: Db, ids: readonly string[]): Map<string, AskedMessage> {
  const rows = db.prepare(`SELECT m.id, m.ts, ${plainNameSql('m.author_id')} AS author, m.content AS text FROM messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as AskedMessage[];
  return new Map(rows.map((r) => [r.id, r]));
}

const said = (m: AskedMessage) => ({ from: m.author, text: cutText(m.text, JEV_TEXT_CHARS) });
const candidateName = (i: number): string => `earlier[${i}]`;
const continuesId = (i: number): string => `continues_${i}`;

export interface AskOptions {
  /** Runs before each send. */
  admit?: () => void;
  signal?: AbortSignal;
  /** A Jev release to ask instead of the pinned one: measurements only. */
  release?: string;
}

/**
 * Asks about `message` among `candidates`, the channel's messages just before it, oldest first. State is structured and
 * questions name candidates by path (`earlier[3]`), per TypeSafe's guidance; all questions go in one request.
 */
export async function askParent(
  jev: DecisionProvider, message: AskedMessage, candidates: readonly AskedMessage[], opts: AskOptions = {},
): Promise<{ view: JevView; costUsd: number | null }> {
  const names = candidates.map((_, i) => candidateName(i));
  const state = {
    message: said(message),
    earlier: candidates.map((c) => ({ ...said(c), minutes_before: Math.round((message.ts - c.ts) / MS_PER_MIN) })),
  };
  const questions: Record<string, Question> = {
    parent: queryRequest(PARENT_QUERY, { options: [...names.map((name) => ({ name, description: '' })), { name: NO_PARENT, description: NO_PARENT_TEXT }] }),
  };
  candidates.forEach((_, i) => (questions[continuesId(i)] = queryRequest(CONTINUES_QUERY, { placeholders: { [CANDIDATE_MARK]: String(i) } })));
  const r = await jev.decide({ state, questions, ...opts });
  const pick = r.answers['parent'];
  const choice = pick?.type === 'choice' ? pick.probabilities : null;
  const view: JevView = {
    choice: choice ? names.map((n) => choice[n] ?? 0) : null,
    none: choice ? (choice[NO_PARENT] ?? 0) : null,
    continues: candidates.map((_, i) => {
      const a = r.answers[continuesId(i)];
      return a ? queryStrength(CONTINUES_QUERY, a) : null;
    }),
  };
  return { view, costUsd: r.costUsd };
}
