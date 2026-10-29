// Jev's stored judgments of a message's candidates, keyed by exactly what was asked, and the chooser + Jev weights the linker uses.
import { createHash } from 'node:crypto';
import { cutText } from '@shared/text';
import type { DecisionProvider } from '../ai/decisions';
import { isRefused } from '../ai/readScope';
import { assertHostedMayRead, localOnlyChannelIds } from '../channelPolicy';
import { getSetting, setSetting, type Db } from '../db';
import { queryFingerprint } from '../jev/queries';
import { askedMessages, askParent, isAnswered, JEV_TEXT_CHARS, RELATES_QUERY, RESPONDS_QUERY, type Answered, type JevView } from './ask';
import { argmax, DEFAULT_WEIGHTS, probabilities, type Weights } from './chooser';
import type { StoredChooser } from './fit';
import { combinedProbabilities, fitCombined } from './jevCombine';
import { CANDIDATE_MAX, JUDGE_BELOW, LINK_KIND, LINK_MIN_CONFIDENCE, ruleLink, type Judge, type LinkInput } from './linker';
import { channelReach, contextInputs, messageInput, queueConversationLinks, storedReplies } from './store';

export const JUDGE_KEY = 'conversations.judge';
/** Held-out replies the weights are fitted on: as many as the measurement that showed the gain (#305). */
export const CALIBRATION_CASES = 300;
/** Fewer answered cases than this leave the judge off: about thirty per weight. */
export const CALIBRATION_MIN = 100;
/** Replies examined at most while gathering cases. */
const CALIBRATION_SCAN_MAX = 20_000;

/** The chooser + Jev weights, valid for one chooser, one Jev release and one version of the questions. */
export interface StoredJudge {
  weights: number[];
  chooser: string;
  model: string;
  queries: string;
  cases: number;
}

/** The questions' version: weights and judgments are for one wording. */
export const judgeQueriesKey = (): string => queryFingerprint([RESPONDS_QUERY, RELATES_QUERY]);
export const chooserKey = (w: Weights): string => JSON.stringify(w);

/** What a judgment answered: the release, the questions as asked, and the texts Jev read. Any change makes it stale. */
export function inputKey(model: string, m: Pick<LinkInput, 'text'>, candidates: readonly Pick<LinkInput, 'id' | 'text'>[]): string {
  const cut = (t: string): string => cutText(t, JEV_TEXT_CHARS);
  return createHash('sha256').update(JSON.stringify([model, judgeQueriesKey(), cut(m.text), candidates.map((c) => [c.id, cut(c.text)])])).digest('base64url');
}

/** The stored weights when they match this chooser and these questions (the release is checked per judgment). */
export function currentJudge(db: Db, chooser: Weights): StoredJudge | null {
  const s = getSetting(db, JUDGE_KEY) as StoredJudge | undefined;
  return s && s.chooser === chooserKey(chooser) && s.queries === judgeQueriesKey() ? s : null;
}

interface Row { key: string; model: string; relates: string }

/** The linker's judge: re-ranks with a current judgment; a stale one is marked failed, so the judge job asks again later. */
export function judgeFor(db: Db, judge: StoredJudge): Judge {
  const get = db.prepare('SELECT input_key AS key, model, relates FROM conversation_judgments WHERE message_id = ? AND failed_at IS NULL');
  const stale = db.prepare('UPDATE conversation_judgments SET failed_at = ? WHERE message_id = ?');
  return (m, recent, chooser) => {
    const row = get.get(m.id) as Row | undefined;
    if (!row) return null;
    const relates = JSON.parse(row.relates) as [number, number][];
    if (row.model !== judge.model || row.key !== inputKey(row.model, m, recent) || relates.length !== recent.length) {
      stale.run(Date.now(), m.id);
      return null;
    }
    const p = combinedProbabilities({ chooser, level: relates.map((r) => r[0]), top: relates.map((r) => r[1]) }, judge.weights);
    const index = argmax(p);
    return { index, probability: p[index]! };
  };
}

/** Stores Jev's answers about `m` (null: the request failed or came back incomplete; asked again after a while). */
export function storeJudgment(db: Db, m: Pick<LinkInput, 'id' | 'ts'> & { channelId: string }, key: string, model: string, view: Answered | null): void {
  db.prepare(`INSERT OR REPLACE INTO conversation_judgments (message_id, channel_id, ts, input_key, model, responds, relates, failed_at, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, m.channelId, m.ts, key, model, view?.responds ?? null,
    view ? JSON.stringify(view.relates.map((r) => [r.level, r.top])) : null, view ? null : Date.now(), Date.now());
}

/** A stored judgment of `m` that still answers these candidates. */
function cachedJudgment(db: Db, id: string, key: string): Answered | null {
  const row = db.prepare('SELECT input_key AS key, responds, relates FROM conversation_judgments WHERE message_id = ? AND failed_at IS NULL')
    .get(id) as { key: string; responds: number; relates: string } | undefined;
  if (row?.key !== key) return null;
  return { responds: row.responds, relates: (JSON.parse(row.relates) as [number, number][]).map(([level, top]) => ({ level, top })) };
}

/** Asks Jev about `m` among `candidates` (or reuses a current judgment) and stores the answer. Null when it failed or was refused (nothing stored). */
export async function judgeMessage(
  db: Db, jev: DecisionProvider, m: LinkInput, channelId: string, candidates: readonly LinkInput[], signal?: AbortSignal,
): Promise<Answered | null> {
  const key = inputKey(jev.model, m, candidates);
  const cached = cachedJudgment(db, m.id, key);
  if (cached) return cached;
  const texts = askedMessages(db, [m.id, ...candidates.map((c) => c.id)]);
  const asked = texts.get(m.id);
  if (!asked || candidates.some((c) => !texts.has(c.id))) return null;
  const admit = () => assertHostedMayRead(db, channelId);
  let reply: Awaited<ReturnType<typeof askParent>>;
  try {
    reply = await askParent(jev, asked, candidates.map((c) => texts.get(c.id)!), { admit, ...(signal ? { signal } : {}) });
  } catch (err) {
    // A failure waits JUDGE_RETRY_MS before the judge job asks again; a cancel isn't a failure.
    if (!signal?.aborted) storeJudgment(db, { id: m.id, ts: m.ts, channelId }, key, jev.model, null);
    throw err;
  }
  // Cancelled while the answer was read: not a failure to store.
  signal?.throwIfAborted();
  // Turned local-only while queued: not judged and not a failure; the judge job skips local-only channels.
  if (isRefused(reply)) return null;
  const { view } = reply;
  // Edited while asked: the answer is for texts that are gone.
  const now = messageInput(db, m.id);
  const fresh = now && inputKey(jev.model, now, contextInputs(db, channelId, now, channelReach(db, channelId), CANDIDATE_MAX)) === key;
  const answered = fresh && isAnswered(view) ? view : null;
  storeJudgment(db, { id: m.id, ts: m.ts, channelId }, key, jev.model, answered);
  return answered;
}

interface CalibrationCase { m: LinkInput; channelId: string; candidates: LinkInput[]; target: number; chooser: Float64Array }

/**
 * Held-out replies the judge would see: older than every reply the chooser was fitted on (so its probabilities are honest),
 * decided by no rule, target among the candidates, and the chooser's pick in the judged range. Hosted-AI channels only.
 * A fit from before `sampleFromTs` has none: the link job refits it at the next start.
 */
function calibrationCases(db: Db, chooser: Weights, fit: StoredChooser | undefined): CalibrationCase[] {
  if (fit && fit.sampleFromTs === undefined) return [];
  const before = fit?.sampleFromTs ?? Infinity;
  const localOnly = localOnlyChannelIds(db);
  const reach = new Map<string, number>();
  const found: CalibrationCase[] = [];
  const replies = storedReplies(db).filter((r) => r.ts < before).slice(0, CALIBRATION_SCAN_MAX);
  for (const r of replies) {
    if (found.length >= CALIBRATION_CASES) break;
    if (localOnly.has(r.channelId)) continue;
    const m = messageInput(db, r.id);
    if (!m) continue;
    if (!reach.has(r.channelId)) reach.set(r.channelId, channelReach(db, r.channelId));
    const candidates = contextInputs(db, r.channelId, m, reach.get(r.channelId)!, CANDIDATE_MAX);
    if (!candidates.length || ruleLink(m, candidates)) continue;
    const target = candidates.findIndex((c) => c.id === r.parentId);
    if (target < 0) continue;
    const p = probabilities(m, candidates, chooser);
    const top = p[argmax(p)]!;
    if (top >= LINK_MIN_CONFIDENCE && top < JUDGE_BELOW) found.push({ m, channelId: r.channelId, candidates, target, chooser: p });
  }
  return found;
}

/** How calibration ended: too few held-out cases (asked nothing), too few answered (Jev failing), or fitted and stored. */
export type Calibration = 'too-few' | 'unanswered' | 'fitted';

/** Fits and stores the chooser + Jev weights for the chooser `fit` stored (defaults without). Reuses stored judgments. */
export async function calibrateJudge(db: Db, jev: DecisionProvider, fit: StoredChooser | undefined, signal?: AbortSignal): Promise<Calibration> {
  const chooser = fit?.weights ?? DEFAULT_WEIGHTS;
  const cases = calibrationCases(db, chooser, fit);
  if (cases.length < CALIBRATION_MIN) return 'too-few';
  let failed = 0;
  let failure: unknown = null;
  const answered = await Promise.all(cases.map((c) => judgeMessage(db, jev, c.m, c.channelId, c.candidates, signal).catch((err: unknown) => {
    signal?.throwIfAborted();
    failed++;
    failure = err;
    return null;
  })));
  if (failed) console.warn(`[conversations] ${failed} of ${cases.length} judge calibration requests failed`, failure);
  const fitted = cases.flatMap((c, i) => {
    const a = answered[i];
    return a ? [{ chooser: c.chooser, level: a.relates.map((r) => r.level), top: a.relates.map((r) => r.top), target: c.target }] : [];
  });
  if (fitted.length < CALIBRATION_MIN) return 'unanswered';
  const stored: StoredJudge = { weights: fitCombined(fitted), chooser: chooserKey(chooser), model: jev.model, queries: judgeQueriesKey(), cases: fitted.length };
  db.transaction(() => {
    setSetting(db, JUDGE_KEY, stored);
    // Judged messages relink with the new weights.
    for (const r of db.prepare(`SELECT j.channel_id AS channelId, MIN(j.ts) AS fromTs, MAX(j.ts) AS untilTs FROM conversation_judgments j
      JOIN conversation_links l ON l.message_id = j.message_id AND l.kind IN ('${LINK_KIND.judged}', '${LINK_KIND.inferred}')
      WHERE j.failed_at IS NULL GROUP BY j.channel_id`).all() as { channelId: string; fromTs: number; untilTs: number }[]) {
      queueConversationLinks(db, r.channelId, r.fromTs, r.untilTs);
    }
  })();
  return 'fitted';
}
