// Asks Jev which earlier message in the channel a message continues, for the chooser's close calls.
import { cutText } from '@shared/text';
import type { Answer, DecisionProvider, Question } from '../ai/decisions';
import type { Db } from '../db';
import { queryRequest, queryStrength } from '../jev/queries';
import { plainNameSql } from '../queries/names';

/** Whether the message responds to anything earlier: asked about the message alone. */
export const RESPONDS_QUERY = 'conversations.responds';
/** How the message relates to one candidate: one Score per candidate, the candidate in its own question (TypeSafe's per-record pattern). */
export const RELATES_QUERY = 'conversations.relates';
/** Characters of each message Jev reads: enough for most chat lines, while twenty-one messages stay a small request. */
export const JEV_TEXT_CHARS = 300;

export interface AskedMessage { id: string; ts: number; author: string; text: string }

/** Jev's answers about one candidate: the Score's position 0–1, and its probability of the top level (responds to it). */
export interface Relation { level: number; top: number }

/** Jev's answers about one message. Null where Jev gave no usable answer. */
export interface JevView {
  /** How strongly `message` responds to anything earlier, 0–1. */
  responds: number | null;
  /** Per candidate, oldest first. */
  relates: (Relation | null)[];
}

/** Author names, times and text of stored messages, by id. */
export function askedMessages(db: Db, ids: readonly string[]): Map<string, AskedMessage> {
  const rows = db.prepare(`SELECT m.id, m.ts, ${plainNameSql('m.author_id')} AS author, m.content AS text FROM messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE m.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as AskedMessage[];
  return new Map(rows.map((r) => [r.id, r]));
}

const said = (m: AskedMessage) => ({ from: m.author, text: cutText(m.text, JEV_TEXT_CHARS) });
const relatesId = (i: number): string => `relates_${i}`;

/** The Score's position and its top level's probability; null for an answer that isn't a Score (an owner may not change the type). */
function relation(a: Answer | undefined): Relation | null {
  if (a?.type !== 'score') return null;
  const level = queryStrength(RELATES_QUERY, a);
  const top = Math.max(...Object.keys(a.probabilities).map(Number));
  return level === null ? null : { level, top: a.probabilities[String(top)] ?? 0 };
}

export interface AskOptions {
  /** Runs before each send. */
  admit?: () => void;
  signal?: AbortSignal;
  /** A Jev release to ask instead of the pinned one: measurements only. */
  release?: string;
}

/**
 * Asks about `message` among `candidates`, the channel's messages just before it, oldest first, in one request. State is
 * the message alone; each candidate rides in its own question, so no question reads the others (docs: per-question context).
 */
export async function askParent(
  jev: DecisionProvider, message: AskedMessage, candidates: readonly AskedMessage[], opts: AskOptions = {},
): Promise<{ view: JevView; costUsd: number | null }> {
  const questions: Record<string, Question> = { responds: queryRequest(RESPONDS_QUERY) };
  candidates.forEach((c, i) => (questions[relatesId(i)] = queryRequest(RELATES_QUERY, { vars: { earlier_message: said(c) } })));
  const r = await jev.decide({ state: { message: said(message) }, questions, ...opts });
  const responds = r.answers['responds'];
  return {
    view: {
      responds: responds ? queryStrength(RESPONDS_QUERY, responds) : null,
      relates: candidates.map((_, i) => relation(r.answers[relatesId(i)])),
    },
    costUsd: r.costUsd,
  };
}
