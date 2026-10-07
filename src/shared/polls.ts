// Discord polls: the limits Discord holds a new poll to, the owner's draft and its payload, and a stored poll as the
// Archive shows it (read from the message's raw `poll`).
import type { ArchiveEmoji } from './types/archive';

/** Longest question Discord takes. */
export const POLL_QUESTION_MAX = 300;
/** Longest answer text Discord takes. */
export const POLL_ANSWER_MAX = 55;
/** Answers one poll may have, fewest and most. */
export const POLL_ANSWERS_MIN = 1;
export const POLL_ANSWERS_MAX = 10;
const HOURS_PER_DAY = 24;
/** Longest a poll may run: 32 days. */
export const POLL_DURATION_HOURS_MAX = 32 * HOURS_PER_DAY;
/** The lengths Discord's poll creator offers, in hours, with their labels. */
export const POLL_DURATIONS: readonly { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 8, label: '8 hours' },
  { hours: HOURS_PER_DAY, label: '24 hours' },
  { hours: 3 * HOURS_PER_DAY, label: '3 days' },
  { hours: 7 * HOURS_PER_DAY, label: '1 week' },
  { hours: 14 * HOURS_PER_DAY, label: '2 weeks' },
];
/** Discord's creator starts at 24 hours. */
export const POLL_DURATION_DEFAULT_HOURS = HOURS_PER_DAY;
/** Discord's only poll layout. */
const POLL_LAYOUT_DEFAULT = 1;

/** A poll the owner writes. */
export interface PollDraft {
  question: string;
  answers: string[];
  durationHours: number;
  multiselect: boolean;
}

/** Why Discord would refuse `d`, or null when it would take it. Text is trimmed first, as it is sent. */
export function pollDraftError(d: PollDraft): string | null {
  const question = d.question.trim();
  const answers = d.answers.map((a) => a.trim());
  if (!question) return 'Ask a question.';
  if (question.length > POLL_QUESTION_MAX) return `A question is at most ${POLL_QUESTION_MAX} characters.`;
  if (answers.length < POLL_ANSWERS_MIN || answers.length > POLL_ANSWERS_MAX) return `A poll has ${POLL_ANSWERS_MIN} to ${POLL_ANSWERS_MAX} answers.`;
  if (answers.some((a) => !a)) return 'Fill in every answer, or remove it.';
  if (answers.some((a) => a.length > POLL_ANSWER_MAX)) return `An answer is at most ${POLL_ANSWER_MAX} characters.`;
  if (!Number.isInteger(d.durationHours) || d.durationHours < 1 || d.durationHours > POLL_DURATION_HOURS_MAX) return 'Not a poll length Discord takes.';
  return null;
}

/** `v` checked as a PollDraft (it comes from the renderer), its text trimmed; throws the reason Discord would refuse it. */
export function checkPollDraft(v: unknown): PollDraft {
  const p = v as Partial<PollDraft> | null;
  if (!p || typeof p.question !== 'string' || !Array.isArray(p.answers) || !p.answers.every((a) => typeof a === 'string') || typeof p.durationHours !== 'number' || typeof p.multiselect !== 'boolean')
    throw new Error('Not a poll.');
  const draft: PollDraft = { question: p.question.trim(), answers: p.answers.map((a) => a.trim()), durationHours: p.durationHours, multiselect: p.multiselect };
  const error = pollDraftError(draft);
  if (error) throw new Error(error);
  return draft;
}

/** The message's `poll` field for a checked draft, as Discord's client sends it. */
export const pollPayload = (d: PollDraft): Record<string, unknown> => ({
  question: { text: d.question },
  answers: d.answers.map((text) => ({ poll_media: { text } })),
  duration: d.durationHours,
  allow_multiselect: d.multiselect,
  layout_type: POLL_LAYOUT_DEFAULT,
});

/** One answer of a stored poll. */
export interface ArchivePollAnswer {
  id: number;
  text: string;
  emoji: ArchiveEmoji | null;
  votes: number;
  /** The owner voted for it. */
  mine: boolean;
}

/** A stored poll as the Archive shows it. */
export interface ArchivePoll {
  question: string;
  answers: ArchivePollAnswer[];
  multiselect: boolean;
  /** When voting ends (epoch ms); null for a poll without an end. */
  expiresAt: number | null;
  /** Discord counted the final results. */
  finalized: boolean;
}

/** A poll as Discord's message object carries it (the fields read here). */
export interface RawPoll {
  question?: { text?: string };
  answers?: { answer_id?: number; poll_media?: { text?: string; emoji?: { id?: string | null; name?: string | null; animated?: boolean } } }[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  results?: RawPollResults;
}

export interface RawPollResults {
  is_finalized?: boolean;
  answer_counts?: { id: number; count: number; me_voted?: boolean }[];
}

/** A message's raw `poll` as the Archive shows it; null when it isn't one. */
export function pollFrom(raw: RawPoll | null | undefined): ArchivePoll | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.answers)) return null;
  const counts = new Map((raw.results?.answer_counts ?? []).map((c) => [c.id, c]));
  const expiry = raw.expiry ? Date.parse(raw.expiry) : NaN;
  return {
    question: raw.question?.text ?? '',
    answers: raw.answers.flatMap((a) => {
      if (typeof a.answer_id !== 'number') return [];
      const e = a.poll_media?.emoji;
      const c = counts.get(a.answer_id);
      return [{ id: a.answer_id, text: a.poll_media?.text ?? '', emoji: e?.name || e?.id ? { id: e.id ?? null, name: e.name ?? '', animated: Boolean(e.animated) } : null, votes: c?.count ?? 0, mine: c?.me_voted === true }];
    }),
    multiselect: raw.allow_multiselect === true,
    expiresAt: Number.isFinite(expiry) ? expiry : null,
    finalized: raw.results?.is_finalized === true,
  };
}

/** The owner's vote on a poll: every answer they now choose; none takes their vote back. */
export interface OwnerPollVote {
  channelId: string;
  messageId: string;
  answerIds: number[];
}

/**
 * Applies one vote change to a raw poll's results: `answerId` gains (`add`) or loses a vote, `own` when it is the
 * owner's. The owner's echo of a change already applied changes nothing; returns whether anything changed.
 */
export function applyPollVote(poll: RawPoll, answerId: number, add: boolean, own: boolean): boolean {
  const results = (poll.results ??= { is_finalized: false, answer_counts: [] });
  const counts = (results.answer_counts ??= []);
  let c = counts.find((x) => x.id === answerId);
  if (own && (c?.me_voted === true) === add) return false;
  if (!c) {
    if (!add) return false;
    c = { id: answerId, count: 0, me_voted: false };
    counts.push(c);
  }
  c.count = Math.max(0, c.count + (add ? 1 : -1));
  if (own) c.me_voted = add;
  return true;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

/** How long a poll still runs, as Discord words it under the votes: `3d left`, `5h left`, `12m left`; null once ended. */
export function pollTimeLeft(expiresAt: number, now: number): string | null {
  const left = expiresAt - now;
  if (left <= 0) return null;
  if (left >= MS_PER_DAY) return `${Math.floor(left / MS_PER_DAY)}d left`;
  if (left >= MS_PER_HOUR) return `${Math.floor(left / MS_PER_HOUR)}h left`;
  return `${Math.max(1, Math.ceil(left / MS_PER_MINUTE))}m left`;
}
