// What the chooser knows about each earlier message as the parent of a new one: archive facts only, never the new message's reply mark.
import { MS_PER_S } from '@shared/units';

/** One message as the chooser sees it. */
export interface ChooserMessage {
  id: string;
  authorId: string;
  ts: number;
  /** Lowercased words long enough to carry a topic. */
  words: ReadonlySet<string>;
  question: boolean;
  /** Users @mentioned in the text. */
  mentions: readonly string[];
  /** The author of the message this one replies to, when it is a Discord reply to a stored message. */
  repliesToAuthor: string | null;
}

/** Shorter words are mostly function words ("the", "and", "you"), which say nothing about a topic. */
export const TOPIC_WORD_MIN_LENGTH = 4;
const WORD = /[\p{L}\p{N}']+/gu;

export function topicWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= TOPIC_WORD_MIN_LENGTH));
}

/** Feature names, in vector order. */
export const FEATURES = [
  /** log of how many messages back the candidate is (the previous message: 0). */
  'distance',
  /** log seconds between the candidate and the message. */
  'delay',
  'sameAuthor',
  /** The message @mentions the candidate's author. */
  'mentionsAuthor',
  /** The candidate @mentions the message's author. */
  'mentionedBy',
  /** The candidate is its author's latest message among the candidates. */
  'latestByAuthor',
  /** The candidate replied to the message's author. */
  'answeredAuthor',
  /** The message's author spoke just before the candidate: a back-and-forth. */
  'followsAuthor',
  'question',
  /** log(1 + topic words both share). */
  'sharedWords',
  /** The message's author spoke after the candidate. */
  'authorSpokeSince',
] as const;
export const FEATURE_COUNT = FEATURES.length;
const F = Object.fromEntries(FEATURES.map((name, i) => [name, i])) as Record<(typeof FEATURES)[number], number>;

const logSeconds = (ms: number): number => Math.log1p(Math.max(0, ms) / MS_PER_S);

/** Writes one row per candidate (same order as `candidates`, oldest first) into `rows`, which holds FEATURE_COUNT numbers per row. */
export function candidateFeatures(m: ChooserMessage, candidates: readonly ChooserMessage[], rows: Float64Array): void {
  const n = candidates.length;
  const latestByAuthor = new Map<string, number>();
  candidates.forEach((c, i) => latestByAuthor.set(c.authorId, i));
  const lastOwn = latestByAuthor.get(m.authorId) ?? -1;
  for (let i = 0; i < n; i++) {
    const c = candidates[i]!;
    const row = i * FEATURE_COUNT;
    let shared = 0;
    for (const w of m.words) if (c.words.has(w)) shared++;
    const other = c.authorId !== m.authorId;
    rows[row + F.distance] = Math.log(n - i);
    rows[row + F.delay] = logSeconds(m.ts - c.ts);
    rows[row + F.sameAuthor] = other ? 0 : 1;
    rows[row + F.mentionsAuthor] = other && m.mentions.includes(c.authorId) ? 1 : 0;
    rows[row + F.mentionedBy] = other && c.mentions.includes(m.authorId) ? 1 : 0;
    rows[row + F.latestByAuthor] = latestByAuthor.get(c.authorId) === i ? 1 : 0;
    rows[row + F.answeredAuthor] = other && c.repliesToAuthor === m.authorId ? 1 : 0;
    rows[row + F.followsAuthor] = other && i > 0 && candidates[i - 1]!.authorId === m.authorId ? 1 : 0;
    rows[row + F.question] = c.question ? 1 : 0;
    rows[row + F.sharedWords] = Math.log1p(shared);
    rows[row + F.authorSpokeSince] = lastOwn > i ? 1 : 0;
  }
}
