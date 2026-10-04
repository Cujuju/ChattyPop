// An on-demand Jev check of one message (right-click), plus the owner's own questions, asked in one request.
import type { JevCheckResult } from '@shared/contract';
import { ruleSubject } from '@shared/rules';
import { validateJevSpec, type JevQuestionSpec } from '@shared/jevQuestion';
import { JEV_QUERIES } from '@shared/jevQueries';
import { answerValue, type Answer, type DecisionProvider, type Question } from '../ai/decisions';
import { assertHostedMayRead } from '../channelPolicy';
import type { Db } from '../db';
import { textMessage } from '../queries/messageText';
import { loadRule, ruleRows } from '../rules/ruleStore';
import { CLASSES } from './classes';
import type { MessageJudge } from './messageJudge';
import { queryRequest } from './queries';
import { customQuestion } from './questions';

/** Catalog ids of the standard checks start with this; the rest of the id is the result id (e.g. check.trolling → trolling). */
const CHECK_PREFIX = 'check.';
/** The standard checks (Settings → Jev → Queries → Jev check), each a single judgment about the message itself. */
const standardChecks = (): { id: string; label: string; question: Question }[] =>
  JEV_QUERIES.filter((q) => q.id.startsWith(CHECK_PREFIX)).map((q) => ({
    id: q.id.slice(CHECK_PREFIX.length),
    label: q.label,
    question: queryRequest(q.id),
  }));

const ASK_ID = 'ask';

const toResult = (id: string, label: string, a: Answer): JevCheckResult['checks'][number] => ({
  id,
  label,
  kind: a.type,
  ...answerValue(a),
});

/**
 * Runs the standard checks, the class labels, every rule's own Jev question and an optional ad-hoc question on one
 * message. Refuses local-AI-only channels. Nothing is stored: it runs only when the owner asks.
 */
export async function checkMessage(
  db: Db,
  judge: MessageJudge,
  jev: DecisionProvider,
  messageId: string,
  ask: JevQuestionSpec | null,
): Promise<JevCheckResult> {
  if (ask) validateJevSpec(ask);
  const m = textMessage(db, messageId); // with its transcripts, as every other Jev path reads it
  if (!m || !m.content.trim()) throw new Error('That message has no text to check.');
  assertHostedMayRead(db, m.channelId);
  const labels = new Map<string, string>();
  const questions: Record<string, Question> = {};
  const add = (id: string, label: string, q: Question): void => {
    questions[id] = q;
    labels.set(id, label);
  };
  for (const c of standardChecks()) add(c.id, c.label, c.question);
  // A class the text settles shows that answer, as its label would; Jev isn't asked it.
  const certain: Record<string, Answer> = {};
  for (const c of CLASSES) {
    const settled = c.certain?.(m);
    if (settled) {
      certain[c.subject] = settled;
      labels.set(c.subject, c.label);
    } else add(c.subject, c.label, queryRequest(c.query));
  }
  for (const row of ruleRows(db)) {
    const q = loadRule(row).spec?.match.find((p) => p.type === 'jev')?.config as JevQuestionSpec | undefined;
    if (q) add(ruleSubject(row.id), row.name, customQuestion(q));
  }
  if (ask) add(ASK_ID, ask.question.trim(), customQuestion(ask));
  const decided = await jev.decide({ state: judge.stateFor(m), questions });
  const answers: Record<string, unknown> = { ...decided.answers, ...certain };
  const checks = [...labels].flatMap(([id, label]) =>
    answers[id] ? [toResult(id, label, answers[id] as Answer)] : [],
  );
  return { checks, costUsd: decided.costUsd };
}
