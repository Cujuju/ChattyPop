// Per-message Jev questions that aren't topics (tags, notable, classes…). They ride in the same one request per
// message as topic questions, for live messages and the lookback catch-up, only while their feature is on.
import type { JevFeature } from '@shared/settings';
import type { Answer, Question } from '../ai/decisions';
import type { LiveAt, TextMessage } from '../arrival';

export interface MessageQuestion {
  /** jev_judgments subject, and the question's id in the request; unique across features. */
  subject: string;
  /** The Settings → Jev toggle(s) that turn it on; any one of them is enough. */
  feature: JevFeature | readonly JevFeature[];
  /** The question for this message, or null when it doesn't apply. */
  question: (m: TextMessage, ctx: QuestionContext) => Question | null;
  /** An answer the text settles on its own; when given, it is stored as Jev's would be and Jev isn't asked. */
  certain?: (m: TextMessage) => Answer | null;
  /** Runs after the answer is stored. `liveAt`: when a live message was checked; null for catch-up and re-asks. */
  onAnswer?: (m: TextMessage, a: Answer, liveAt: LiveAt) => void;
  /** A chip shown on the message for a stored answer (value; choice label), or null for none. */
  label?: (stored: StoredAnswer) => string | null;
}

/** How the message asked about arrived: live (catch-up and re-asks aren't), and whether its text is an edit. */
export interface QuestionContext {
  live: boolean;
  edit: boolean;
  mayAct(actionType: string): boolean;
}

/** An answer as jev_judgments keeps it: noul/score in value; a choice's option in label, its probability in value. */
export interface StoredAnswer {
  value: number;
  label: string | null;
}

/**
 * Who asks a question, which sets its place in the request: host built-ins, then bundled plugins' in build order,
 * then those a plugin asks for the owner (custom tags). Independent of when each registered, so plugin off/on keeps
 * the order. A plugin's `id` owns the question's chips.
 */
export type QuestionOwner = 'host' | { plugin: string; buildIndex: number; forOwner?: boolean };

const ownerRank = (o: QuestionOwner): [number, number] =>
  o === 'host' ? [0, 0] : o.forOwner ? [2, 0] : [1, o.buildIndex];

const registered = new Map<string, { q: MessageQuestion; rank: [number, number]; pluginId: string | null }>();

/** Registers (or replaces, by subject) a per-message question: at core init, or when a plugin registers one. */
export function registerMessageQuestion(q: MessageQuestion, owner: QuestionOwner = 'host'): () => void {
  const entry = { q, rank: ownerRank(owner), pluginId: owner === 'host' ? null : owner.plugin };
  registered.set(q.subject, entry);
  return () => {
    if (registered.get(q.subject) === entry) registered.delete(q.subject);
  };
}

/** Drops a question whose owner went away (a deleted tag). */
export function unregisterMessageQuestion(subject: string): void {
  registered.delete(subject);
}

/** Whether `q` (as messageQuestions returned it) is still registered for its subject: not replaced or disposed since. */
export const isRegistered = (q: MessageQuestion): boolean => registered.get(q.subject)?.q === q;

/** In request order: by owner, then registration order (a stable sort). */
export function messageQuestions(): MessageQuestion[] {
  return [...registered.values()].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map((r) => r.q);
}

/** A registered question's chip for stored answers, and the plugin that asks it (null: the host). */
export interface QuestionLabel {
  label: NonNullable<MessageQuestion['label']>;
  pluginId: string | null;
}

/** Chips by subject: each registered question that gives stored answers a label. */
export const questionLabels = (): Map<string, QuestionLabel> =>
  new Map([...registered].flatMap(([subject, { q, pluginId }]) => (q.label ? [[subject, { label: q.label, pluginId }] as const] : [])));

/** The toggles that turn a question on, as a list. */
export const featuresOf = (q: MessageQuestion): readonly JevFeature[] =>
  typeof q.feature === 'string' ? [q.feature] : q.feature;
