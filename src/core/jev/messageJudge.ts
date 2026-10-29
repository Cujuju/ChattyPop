import { errorMessage } from '@shared/errors';
import { MS_PER_DAY } from '@shared/units';
import { clipMessage } from '../ai/clip';
import { answerValue, carriedQuestion, type Answer, type DecisionProvider, type DecisionRequest, type DecisionResult, type Question } from '../ai/decisions';
import { isRefused, refusable, scopedDecider, type Refused } from '../ai/readScope';
import { isLocalOnly } from '../channelPolicy';
import type { PluginDb } from '../plugins/pluginDb';
import { archiveReplyTargets, type ReplyTarget } from '../plugins/archiveReplies';
import { LINKED_TEXT_SQL, MESSAGE_TEXT_SQL } from '../queries/messageText';
import { plainNameSql } from '../queries/names';
import { visibleMessageSql, withinSelectedScopeSql } from '../queries/privacy';
import type { TextMessage } from '../arrival';
import { BATCH_STATE, batchKey } from './messageBatch';

/** Judges messages from the last day onward. Older backfill is read history; edited topics retain yesterday’s matches. */
export const MEANING_LOOKBACK_MS = MS_PER_DAY;
/** Preceding messages sent as context, so a short reply ("same", "it's out") can be understood without diluting the state. */
const CONTEXT_BEFORE = 2;
/** jev_judgments.model of an answer the message's text settled on its own (MessageQuestion.certain), not Jev's. */
const SETTLED_BY_TEXT = 'text';
/** Introduces a message's linked text inside `message`, so Jev reads it as part of what the message says. */
const LINKED_MARK = 'linked post:';

/** No Jev request was sent: no questions, or the read policy refused it. */
const UNASKED = { answers: {}, costUsd: null } as const;

/** Caps batch size at 25. October 2026 measurements matched single-message label jitter at half cost; failed batches retry individually. */
const MESSAGES_PER_REQUEST = 25;
/** Jev's answers for one message, keyed by subject; a missing subject means no usable answer. */
export type Answers = Record<string, Answer>;
/** Checks question freshness when answers arrive. Edited, replaced or disposed questions produce no stored or returned answers. */
export type Fresh = (subject: string) => boolean;
/** For callers whose questions can't go stale while asked. */
const ALWAYS_FRESH: Fresh = () => true;
/** An owner-requested judgment's options: answers the text settled, and whether each question is still current. */
export interface JudgeOptions {
  certain?: Answers;
  fresh?: Fresh;
}

/** One message's share of a batched judgment: its questions for Jev, the answers its text settles, and their freshness. */
export interface BatchItem {
  m: TextMessage;
  questions: Record<string, Question>;
  certain: Answers;
  /** Default: always fresh. */
  fresh?: Fresh;
}

/** A batched judgment's outcome: answers by message id, the messages whose request failed, and each request's cost. */
export interface BatchResult {
  answers: Map<string, Answers>;
  failed: Set<string>;
  costs: (number | null)[];
}

/** Live requests combine all message questions; catch-up batches messages. Stores answer values/labels with reply and two preceding messages as context. */
export class MessageJudge {
  constructor(private readonly db: PluginDb) {}

  /** Fire-and-forget judgment with text-certain answers. Returns false if nothing settles; otherwise invokes exactly one fresh-answer or failure callback. */
  judge(jev: DecisionProvider, m: TextMessage, questions: Record<string, Question>, onAnswers: (a: Answers) => void, onFailed: () => void, certain: Answers = {}, fresh: Fresh = ALWAYS_FRESH): boolean {
    if (!m.content || m.ts < Date.now() - MEANING_LOOKBACK_MS) return false;
    // Every message-level Jev call passes here: a local-AI-only channel's text never goes to Jev (OpenRouter).
    const asked = isLocalOnly(this.db, m.channelId) ? {} : questions;
    if (!Object.keys(asked).length && !Object.keys(certain).length) return false;
    this.ask(jev, m, asked, certain, fresh).then((r) => onAnswers(r.answers), (err: unknown) => {
      console.warn('[jev] message judgment failed:', errorMessage(err));
      onFailed();
    });
    return true;
  }

  /** Asks Jev `questions` about `m` alone, with its context; no answer is stored. Refused unsent if its channel turns local-only. */
  decideAbout<Q extends Record<string, Question>>(jev: DecisionProvider, m: TextMessage, questions: Q): Promise<DecisionResult<Q> | Refused> {
    return this.decide(jev, [m.channelId], { state: this.stateFor(m), questions });
  }

  /**
   * Every request carrying message text goes through here: it declares the channels it reads, checked against local-AI-only
   * when queued and again when sent (scopedDecider), so a policy changed while it waited for a slot holds: Refused.
   */
  private decide<Q extends Record<string, Question>>(jev: DecisionProvider, reads: string[], req: DecisionRequest<Q>): Promise<DecisionResult<Q> | Refused> {
    return refusable(scopedDecider(jev, () => this.db).decide({ ...req, reads: [...new Set(reads)] }));
  }

  /**
   * Whether `m`'s text (its own, derived and linked) is still the archive's: false once an edit or later text replaced it.
   * A message the archive doesn't hold has no newer text.
   */
  isCurrent(m: TextMessage): boolean {
    const now = this.db.prepare(`SELECT ${MESSAGE_TEXT_SQL} AS content, ${LINKED_TEXT_SQL} AS linked FROM messages m WHERE m.id = ?`).get(m.id) as
      | Pick<TextMessage, 'content' | 'linked'>
      | undefined;
    return !now || (now.content === m.content && now.linked === m.linked);
  }

  /** Context includes the message, reply target, two preceding messages and linked text, so bare links include post content. */
  private stateFor(m: TextMessage): Record<string, unknown> {
    const reply = this.replyTo(m);
    const linked = m.linked ? `\n(${LINKED_MARK} ${clipMessage(m.linked)})` : '';
    return {
      earlier: this.earlier(m),
      ...(reply ? { replying_to: `${reply.author}: ${clipMessage(reply.content)}` } : {}),
      message: `${this.authorName(m.authorId)}: ${clipMessage(m.content)}${linked}`,
    };
  }

  /** Owner-requested judgments ignore age. Local-only channels return text-certain answers only; stale answers are discarded. */
  async judgeNow(jev: DecisionProvider, m: TextMessage, questions: Record<string, Question>, opts: JudgeOptions = {}): Promise<{ answers: Answers; costUsd: number | null }> {
    return this.ask(jev, m, isLocalOnly(this.db, m.channelId) ? {} : questions, opts.certain ?? {}, opts.fresh ?? ALWAYS_FRESH);
  }

  /** Batches messages with independent state. Unsupported questions or failed batches retry individually. Local-only questions are dropped; text-certain answers are stored. */
  async judgeMany(jev: DecisionProvider, items: BatchItem[]): Promise<BatchResult> {
    const result: BatchResult = { answers: new Map(), failed: new Set(), costs: [] };
    type Batch = { members: { item: BatchItem; keys: Record<string, string> }[]; questions: Record<string, Question>; chars: number };
    const batches: Batch[] = [];
    const alone: BatchItem[] = [];
    for (const item of items) {
      const asked = isLocalOnly(this.db, item.m.channelId) ? {} : item.questions;
      if (!Object.keys(asked).length) {
        result.answers.set(item.m.id, this.keep(jev, item.m, {}, {}, item.certain, item.fresh ?? ALWAYS_FRESH));
        continue;
      }
      const state = this.stateFor(item.m);
      const carried = Object.entries(asked).map(([s, q]) => [batchKey(s, item.m.id), s, carriedQuestion(q, state)] as const);
      if (carried.some(([, , q]) => !q)) {
        alone.push({ ...item, questions: asked });
        continue;
      }
      const questions = Object.fromEntries(carried.map(([k, , q]) => [k, q!]));
      const size = JSON.stringify(questions).length;
      let open = batches.at(-1);
      if (!open || open.members.length >= MESSAGES_PER_REQUEST || open.chars + size > jev.maxInputChars) {
        batches.push((open = { members: [], questions: {}, chars: 0 }));
      }
      open.members.push({ item: { ...item, questions: asked }, keys: Object.fromEntries(carried.map(([k, s]) => [k, s])) });
      Object.assign(open.questions, questions);
      open.chars += size;
    }
    const one = async (item: BatchItem): Promise<void> => {
      try {
        const r = await this.ask(jev, item.m, item.questions, item.certain, item.fresh ?? ALWAYS_FRESH);
        result.costs.push(r.costUsd);
        result.answers.set(item.m.id, r.answers);
      } catch (err: unknown) {
        console.warn('[jev] message judgment failed:', errorMessage(err));
        result.failed.add(item.m.id);
      }
    };
    await Promise.all([
      ...alone.map(one),
      ...batches.map(async (b) => {
        if (b.members.length === 1) return one(b.members[0]!.item);
        try {
          const r = await this.decide(jev, b.members.map(({ item }) => item.m.channelId), { state: BATCH_STATE, questions: b.questions });
          // A member's channel turned local-only: each is asked alone, where only that one is refused.
          if (isRefused(r)) return void (await Promise.all(b.members.map(({ item }) => one(item))));
          result.costs.push(r.costUsd);
          for (const { item, keys } of b.members) {
            const answers = Object.fromEntries(Object.entries(keys).flatMap(([k, s]) => (r.answers[k] ? [[s, r.answers[k] as Answer]] : [])));
            result.answers.set(item.m.id, this.keep(jev, item.m, item.questions, answers, item.certain, item.fresh ?? ALWAYS_FRESH));
          }
        } catch (err: unknown) {
          // One message can sink a batch (Jev refuses the whole request), so each is asked again on its own.
          console.warn('[jev] batched judgment failed, asking each message alone:', errorMessage(err));
          await Promise.all(b.members.map(({ item }) => one(item)));
        }
      }),
    ]);
    return result;
  }

  /**
   * Asks Jev `questions` (none: no request), then stores its fresh answers and the `certain` ones. A channel turned
   * local-only before sending refuses the request: an outcome like asking nothing, not a failure.
   */
  private async ask(jev: DecisionProvider, m: TextMessage, questions: Record<string, Question>, certain: Answers, fresh: Fresh): Promise<{ answers: Answers; costUsd: number | null }> {
    const decided = Object.keys(questions).length ? await this.decideAbout(jev, m, questions) : UNASKED;
    const asked = isRefused(decided) ? UNASKED : decided;
    return { answers: this.keep(jev, m, asked === UNASKED ? {} : questions, asked.answers as Answers, certain, fresh), costUsd: asked.costUsd };
  }

  /**
   * Stores the answers to `questions` Jev gave and the `certain` ones whose question is still fresh; returns them by subject.
   * None when `m`'s text changed meanwhile: they judged text it no longer has, and its newer text is asked on its own.
   */
  private keep(jev: DecisionProvider, m: TextMessage, questions: Record<string, Question>, answers: Answers, certain: Answers, fresh: Fresh): Answers {
    if (!this.isCurrent(m)) return {};
    const store = this.db.prepare('INSERT OR REPLACE INTO jev_judgments (message_id, subject, value, label, model, judged_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    const out: Answers = {};
    const put = (subject: string, a: Answer, model: string): void => {
      if (!fresh(subject)) return;
      out[subject] = a;
      const v = answerValue(a);
      store.run(m.id, subject, v.value, v.choice, model, now);
    };
    this.db.transaction(() => {
      for (const [subject, a] of Object.entries(certain)) put(subject, a, SETTLED_BY_TEXT);
      for (const subject of Object.keys(questions)) {
        const a = answers[subject];
        if (a) put(subject, a, jev.model);
      }
    })();
    return out;
  }

  /** The message `m` replies to, or null (not a reply, or the payload is unreadable). */
  replyTo(m: TextMessage): ReplyTarget | null {
    return archiveReplyTargets(this.db, [m.id]).get(m.id) ?? null;
  }

  /** Subjects already answered for these messages (the catch-up skips them). */
  judgedSince(sinceTs: number): Set<string> {
    const rows = this.db.prepare('SELECT j.message_id AS m, j.subject AS s FROM jev_judgments j JOIN messages x ON x.id = j.message_id WHERE x.ts >= ?').all(sinceTs) as { m: string; s: string }[];
    return new Set(rows.map((r) => `${r.m}|${r.s}`));
  }

  /** Drops stored scores for a subject whose question changed (topic edited or deleted). */
  forget(subject: string): void {
    this.db.prepare('DELETE FROM jev_judgments WHERE subject = ?').run(subject);
  }

  /** Preceding messages as context; text privacy mode hides is left out unless it hides `m` too (as for reply targets). */
  private earlier(m: TextMessage): string[] {
    const rows = this.db
      .prepare(
        `SELECT ${plainNameSql('m.author_id')} AS author, ${MESSAGE_TEXT_SQL} AS content
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = @channel AND m.ts < @ts AND ${MESSAGE_TEXT_SQL} != ''
           AND ${withinSelectedScopeSql(visibleMessageSql('m'), '@selected')} ORDER BY m.ts DESC LIMIT @limit`,
      )
      .all({ channel: m.channelId, ts: m.ts, selected: m.id, limit: CONTEXT_BEFORE }) as { author: string; content: string }[];
    return rows.reverse().map((r) => `${r.author}: ${clipMessage(r.content)}`);
  }

  private authorName(id: string): string {
    const r = this.db.prepare(`SELECT ${plainNameSql('u.id')} AS name FROM users u WHERE u.id = ?`).get(id) as { name: string } | undefined;
    return r?.name ?? id;
  }
}
