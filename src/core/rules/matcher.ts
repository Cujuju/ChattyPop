// Rule matching on every stored message text: gates, narrowing and direct matches (keywords, contents, an @mention
// or reply to the owner), then one Jev request per message carrying every rule's question (meaning, the owner's own,
// built-ins), the registered per-message questions and urgency. A match fires its rule (RuleEngine.fire); only live
// matches notify, and not when Jev rates the message not urgent.
import type { RawUser } from '@shared/discord';
import type { JevRerunResult } from '@shared/jevQueries';
import type { JevFeature } from '@shared/settings';
import { sumCosts, type DecisionProvider, type Question } from '../ai/decisions';
import { MATCH_KIND, type Hit } from './hit';
import { liveAtOf, type Arrived, type LiveAt, type TextMessage } from '../arrival';
import type { Db } from '../db';
import { MEANING_LOOKBACK_MS, MessageJudge, type Answers, type BatchResult, type Fresh } from '../jev/messageJudge';
import { featuresOf, isRegistered, messageQuestions, type MessageQuestion, type QuestionContext } from '../jev/messageQuestions';
import type { RuleQuestion } from '../jev/questions';
import { TEXT_MESSAGE_COLUMNS } from '../queries/messageText';
import {
  directMatch,
  questionMatch,
  gatesPass,
  narrowPasses,
  scopePasses,
  type CompiledRule,
  type MessageFacts,
} from './compile';
import { hasHistory, type RuleEngine } from './engine';
import { questionSignature } from './ruleStore';

/** One message's Jev request: its questions, and who acts on each answer. */
interface Request {
  eventId: number;
  jev: DecisionProvider;
  questions: Record<string, Question>;
  /** Answers the text settled on its own (MessageQuestion.certain): stored, never asked. */
  certain: Answers;
  /** Each rule asked, with its question signature when asked: an edit meanwhile makes its answer stale. */
  rules: { r: CompiledRule; q: RuleQuestion; signature: string }[];
  extras: MessageQuestion[];
  /** A subject is fresh while any of its askers still asks it unchanged. */
  fresh: Fresh;
}

/** How catch-up and re-asks judge a message: as a missed one. */
const PAST: QuestionContext = { live: false, edit: false, mayAct: () => false };

export class RuleMatcher {
  private catchUpQueued = false;
  private readonly judge: MessageJudge;
  /** The signed-in Discord user; unknown until main reports it. */
  private self: RawUser | null = null;

  constructor(
    private readonly db: Db,
    private readonly engine: RuleEngine,
    /** Jev when the user turned that feature on and a key pays for it; read per message so Settings apply at once. */
    private readonly jevFor: (feature: JevFeature) => DecisionProvider | null,
  ) {
    this.judge = new MessageJudge(db);
  }

  setSelf(user: RawUser): void {
    const first = this.self === null;
    this.self = user;
    if (first) this.catchUpJudgments(); // "Aimed at you" can only be judged once the owner is known
  }

  /**
   * Every new or edited message, once derived (its attachments and links stored). `arrived`: how and when ChattyPop
   * got the text; a transcript's is its message's first arrival, timed when its audio was queued. `askJev` false: only
   * direct matches and the answers its text settles (MessageQuestion.certain); Jev isn't asked.
   */
  check(m: TextMessage, arrived: Arrived, askJev = true): void {
    const eventId = this.engine.nextEventId();
    this.engine.kinds.message(m);
    const liveAt = liveAtOf(m, arrived);
    const fired = new Set<string>();
    const ctx = { live: liveAt !== null, edit: arrived.edit, mayAct: (type: string) => fired.has(type) };
    const ask = this.evaluate(m, ctx, (r, hit) => {
      if (this.hit(r, m, hit, liveAt, eventId)) {
        for (const a of r.spec.actions) fired.add(a.type);
      }
    });
    // Jev judges text; a message without any is matched directly or not at all.
    const req = m.content ? this.request(eventId, m, askJev ? ask : [], ctx, null, askJev) : null;
    const settle = () => this.engine.kinds.settle({ eventId, m, answers: null });
    const asked =
      req !== null &&
      this.judge.judge(req.jev, m, req.questions, (a) => this.apply(m, a, req, liveAt), settle, req.certain, req.fresh);
    if (!asked) settle();
  }

  /** Fires every rule `m` matches directly (via `onHit`); returns the rules still to ask Jev about. */
  private evaluate(m: TextMessage, ctx: QuestionContext, onHit: (r: CompiledRule, hit: Hit) => void): CompiledRule[] {
    const f = this.engine.facts(m);
    const ask: CompiledRule[] = [];
    for (const r of this.engine.messageRules()) {
      if (!this.eligible(r, f, ctx) || !narrowPasses(r, f)) continue;
      const hit = directMatch(r, f, this.self);
      if (hit) onHit(r, hit);
      else if (!r.byNarrow) ask.push(r);
    }
    return ask;
  }

  /**
   * A message older than the rule is history: an Alert rule takes it on where and who (the alert lands read). Newer: the
   * gates.
   */
  private eligible(r: CompiledRule, f: MessageFacts, ctx: QuestionContext): boolean {
    if (f.m.ts < r.armedAt) return hasHistory(r) && scopePasses(r, f);
    return gatesPass(r, f, ctx);
  }

  /** A match: fires the rule, or for a message older than it, records history. */
  private hit(r: CompiledRule, m: TextMessage, hit: Hit, liveAt: LiveAt, eventId: number): boolean {
    if (m.ts >= r.armedAt) return this.engine.fire(r, m, hit, liveAt, eventId);
    this.engine.recordHistory(r, m, hit, eventId);
    return false;
  }

  /**
   * Every Jev question that applies to `m` now, or null. `judged` (catch-up) drops subjects already answered; urgency
   * is asked only for a live message that has or may get an alert. `askJev` false keeps only the settled answers.
   */
  private request(
    eventId: number,
    m: TextMessage,
    ask: CompiledRule[],
    ctx: QuestionContext,
    judged: Set<string> | null,
    askJev = true,
  ): Request | null {
    let jev: DecisionProvider | null = null;
    const use = (features: readonly JevFeature[]): boolean => {
      const j = features.map((f) => this.jevFor(f)).find((x) => x !== null) ?? null;
      jev ??= j;
      return j !== null;
    };
    const unasked = (subject: string): boolean => !judged?.has(`${m.id}|${subject}`);
    const questions: Record<string, Question> = {};
    const rules: Request['rules'] = [];
    const facts = this.engine.facts(m);
    for (const r of ask) {
      const q = questionMatch(r, facts, this.self);
      if (!q || !unasked(q.subject) || !use(q.features)) continue;
      questions[q.subject] = q.question;
      rules.push({ r, q, signature: questionSignature(r.spec) });
    }
    const context: QuestionContext = {
      ...ctx,
      mayAct: (type) => ctx.mayAct(type) || rules.some(({ r }) => r.spec.actions.some((a) => a.type === type)),
    };
    const extras: MessageQuestion[] = [];
    const certain: Answers = {};
    for (const q of messageQuestions()) {
      if (!unasked(q.subject) || !use(featuresOf(q))) continue;
      const settled = q.certain?.(m);
      if (settled) {
        certain[q.subject] = settled;
        extras.push(q);
        continue;
      }
      const question = askJev ? q.question(m, context) : null;
      if (!question) continue;
      questions[q.subject] = question;
      extras.push(q);
    }
    const fresh: Fresh = (subject) =>
      rules.some(({ r, q, signature }) => q.subject === subject && this.current(r.id, signature) !== undefined) ||
      extras.some((q) => q.subject === subject && isRegistered(q));
    return jev && Object.keys({ ...questions, ...certain }).length
      ? { eventId, jev, questions, certain, rules, extras, fresh }
      : null;
  }

  /** The rule as compiled now, if it still asks the question it asked with `signature`; undefined when off, deleted or edited. */
  private current(ruleId: number, signature: string): CompiledRule | undefined {
    const r = this.engine.find(ruleId);
    return r && questionSignature(r.spec) === signature ? r : undefined;
  }

  /**
   * Fires the rules Jev matched, runs registered handlers, then notifies every new alert of this message unless not
   * urgent. `answers` holds only fresh subjects; a rule sharing one is still skipped if it was itself edited meanwhile.
   */
  private apply(m: TextMessage, answers: Answers, req: Request, liveAt: LiveAt): void {
    for (const { r, q, signature } of req.rules) {
      const a = answers[q.subject];
      const p = a ? q.match(a) : null;
      const current = this.current(r.id, signature); // skip rules turned off, deleted or re-asked meanwhile
      if (p !== null && current)
        this.hit(current, m, { kind: MATCH_KIND.meaning, probability: p, highlight: null }, liveAt, req.eventId);
    }
    for (const q of req.extras) {
      const a = answers[q.subject];
      if (a && isRegistered(q)) q.onAnswer?.(m, a, liveAt);
    }
    this.engine.kinds.settle({ eventId: req.eventId, m, answers });
  }

  /**
   * Re-asks these subjects' questions about past messages (Settings → Jev → Queries → Run on past messages) and acts on
   * the answers as for missed ones. Questions whose Settings → Jev switch is off aren't asked.
   */
  async rejudge(messages: TextMessage[], subjects: Set<string>): Promise<JevRerunResult> {
    const due: { m: TextMessage; req: Request }[] = [];
    for (const m of messages) {
      const eventId = this.engine.nextEventId();
      const req = this.request(
        eventId,
        m,
        this.evaluate(m, PAST, () => undefined),
        PAST,
        null,
      );
      const questions = Object.fromEntries(Object.entries(req?.questions ?? {}).filter(([s]) => subjects.has(s)));
      const certain = Object.fromEntries(Object.entries(req?.certain ?? {}).filter(([s]) => subjects.has(s)));
      if (!req || !Object.keys({ ...questions, ...certain }).length) {
        this.engine.kinds.settle({ eventId, m, answers: null });
        continue;
      }
      due.push({
        m,
        req: {
          ...req,
          questions,
          certain,
          rules: req.rules.filter(({ q }) => subjects.has(q.subject)),
          extras: req.extras.filter((q) => subjects.has(q.subject)),
        },
      });
    }
    const r = await this.judgeAll(due);
    // Settled-only messages cost no request, so they don't count as asked.
    const asked = due.filter(({ req }) => Object.keys(req.questions).length).length;
    return { asked, failed: r.failed.size, costUsd: sumCosts(r.costs.filter((c): c is number => c !== null)) };
  }

  /** Coalesces catch-up until synchronous plugin activation and settings callbacks finish. */
  requestCatchUp(): void {
    if (this.catchUpQueued) return;
    this.catchUpQueued = true;
    queueMicrotask(() => {
      this.catchUpQueued = false;
      this.catchUpJudgments();
    });
  }

  /**
   * Matches the lookback window again and asks Jev whatever it still lacks: after an interrupted run, a time with
   * Jev off, a new or edited rule, or a newly known owner. Subjects already answered are skipped.
   */
  catchUpJudgments(): void {
    const since = Date.now() - MEANING_LOOKBACK_MS;
    const judged = this.judge.judgedSince(since);
    const recent = this.db
      .prepare(`SELECT ${TEXT_MESSAGE_COLUMNS} FROM messages m WHERE m.ts >= ? ORDER BY m.ts`)
      .all(since) as TextMessage[];
    const due: { m: TextMessage; req: Request }[] = [];
    for (const m of recent) {
      const eventId = this.engine.nextEventId();
      const fired = new Set<string>();
      const ctx = { ...PAST, mayAct: (type: string) => fired.has(type) };
      const ask = this.evaluate(m, ctx, (r, hit) => {
        if (this.hit(r, m, hit, null, eventId)) {
          for (const a of r.spec.actions) fired.add(a.type);
        }
      });
      const req = m.content ? this.request(eventId, m, ask, ctx, judged) : null;
      if (req) due.push({ m, req });
      else this.engine.kinds.settle({ eventId, m, answers: null });
    }
    void this.judgeAll(due);
  }

  /**
   * Judges past messages in batched requests and acts on each one's answers as for a missed message. Every feature's Jev
   * uses the same route, so the first request's provider carries them all.
   */
  private async judgeAll(due: { m: TextMessage; req: Request }[]): Promise<BatchResult> {
    const jev = due[0]?.req.jev;
    if (!jev) return { answers: new Map(), failed: new Set(), costs: [] };
    const r = await this.judge.judgeMany(
      jev,
      due.map(({ m, req }) => ({ m, questions: req.questions, certain: req.certain, fresh: req.fresh })),
    );
    for (const { m, req } of due) {
      const a = r.answers.get(m.id);
      if (a) this.apply(m, a, req, null);
      else this.engine.kinds.settle({ eventId: req.eventId, m, answers: null });
    }
    return r;
  }

  /** Drops a rule's stored Jev answers (its question or meaning changed), so the lookback window is asked again. */
  forget(subject: string): void {
    this.judge.forget(subject);
  }

}
