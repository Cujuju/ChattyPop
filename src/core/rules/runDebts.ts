// Timed claims and per-action windows still owed after a failure or interrupted session.
import {
  TIMED_ATTEMPTS_MAX, TIMED_RUN_ACTION_MARK, TIMED_RUN_PREFIX, timedRetryDelayMs, type TimedTriggerKind,
} from '@shared/ruleTime';
import type { Db } from '../db';
import type { ActionResult } from './actions';
import { claimRun, recordOutcome, TIMED_ACTION_RUN, WINDOW_END } from './ruleStore';

/** One action a timed run still owes: where its window starts and the attempts begun. */
export interface RunDebt { actionId: string; sinceTs: number; attempts: number }
/** A timed run with unsettled actions that may be attempted now. */
export interface OwedRun { runId: number; key: string; untilTs: number; timing: TimedTriggerKind; debts: RunDebt[] }

/** Claims a timed run and writes what it owes each action, in one transaction; null when already claimed. */
export function claimTimedRun(
  db: Db, ruleId: number, key: string, now: number,
  window: { untilTs: number; timing: TimedTriggerKind }, actions: readonly { actionId: string; sinceTs: number }[],
): number | null {
  return db.transaction(() => {
    const runId = claimRun(db, ruleId, key, null, true, now, window.untilTs);
    if (runId === null) return null;
    const insert = db.prepare('INSERT INTO rule_run_debts (run_id, action_id, since_ts, timing, retry_at) VALUES (?, ?, ?, ?, ?)');
    for (const a of actions) insert.run(runId, a.actionId, a.sinceTs, window.timing, now);
    return runId;
  })();
}

/** The rule's payable run with the earliest window end, or null. `debts` holds its unspent debts only. */
export function oldestOwedRun(db: Db, ruleId: number, now: number): OwedRun | null {
  // Read from the debts, which are few, not from the rule's whole run history.
  const run = db.prepare(
    `SELECT id AS runId, event_key AS key, ${WINDOW_END} AS untilTs
     FROM (SELECT DISTINCT run_id FROM rule_run_debts WHERE attempts < @max) JOIN rule_runs ON id = run_id
     WHERE rule_id = @ruleId
       AND NOT EXISTS (SELECT 1 FROM rule_run_debts d WHERE d.run_id = rule_runs.id AND d.attempts < @max AND d.retry_at > @now)
     ORDER BY ${WINDOW_END}, id LIMIT 1`,
  ).get({ ruleId, now, max: TIMED_ATTEMPTS_MAX }) as Omit<OwedRun, 'timing' | 'debts'> | undefined;
  if (!run) return null;
  const debts = db.prepare(
    'SELECT action_id AS actionId, since_ts AS sinceTs, attempts, timing FROM rule_run_debts WHERE run_id = ? AND attempts < ? ORDER BY rowid',
  ).all(run.runId, TIMED_ATTEMPTS_MAX) as (RunDebt & { timing: TimedTriggerKind })[];
  return { ...run, timing: debts[0]!.timing, debts: debts.map(({ timing: _, ...d }) => d) };
}

/** Counts an attempt before the action runs and sets when the next may begin; null when the debt is gone. */
export function beginAttempt(db: Db, runId: number, actionId: string, now: number): number | null {
  return db.transaction(() => {
    const debt = db.prepare('SELECT attempts FROM rule_run_debts WHERE run_id = ? AND action_id = ?').get(runId, actionId) as Pick<RunDebt, 'attempts'> | undefined;
    if (!debt) return null;
    const attempt = debt.attempts + 1;
    db.prepare('UPDATE rule_run_debts SET attempts = ?, retry_at = ? WHERE run_id = ? AND action_id = ?')
      .run(attempt, now + (timedRetryDelayMs(attempt) ?? 0), runId, actionId);
    return attempt;
  })();
}

/** Records the outcome and settles the debt atomically: done/skipped clear it, failed keeps it and re-times the retry. */
export function settleAttempt(db: Db, runId: number, action: { id: string; type: string }, result: ActionResult, now: number, satOut: boolean): void {
  db.transaction(() => {
    recordOutcome(db, runId, action.id, action.type, result.outcome, result.detail, now, satOut);
    if (result.outcome !== 'failed') {
      db.prepare('DELETE FROM rule_run_debts WHERE run_id = ? AND action_id = ?').run(runId, action.id);
      return;
    }
    const debt = db.prepare('SELECT attempts FROM rule_run_debts WHERE run_id = ? AND action_id = ?').get(runId, action.id) as Pick<RunDebt, 'attempts'> | undefined;
    const delay = debt ? timedRetryDelayMs(debt.attempts) : null;
    if (delay !== null) db.prepare('UPDATE rule_run_debts SET retry_at = ? WHERE run_id = ? AND action_id = ?').run(now + delay, runId, action.id);
  })();
}

/** Drops the rule's debts for windows ended at or before `beforeTs`, and for actions no longer in `actionIds`. */
export function forgiveDebts(db: Db, ruleId: number, beforeTs: number, actionIds: readonly string[]): void {
  db.prepare(
    `DELETE FROM rule_run_debts WHERE EXISTS (SELECT 1 FROM rule_runs WHERE id = rule_run_debts.run_id AND rule_id = @ruleId
       AND (${WINDOW_END} <= @beforeTs OR rule_run_debts.action_id NOT IN (SELECT value FROM json_each(@actionIds))))`,
  ).run({ ruleId, beforeTs, actionIds: JSON.stringify(actionIds) });
}

/** Timed runs of this action whose window ends after `untilTs`, with the same applicability as lastTimedRun. */
export function laterTimedRuns(db: Db, ruleId: number, actionId: string, untilTs: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM rule_runs WHERE ${TIMED_ACTION_RUN} AND ${WINDOW_END} > @untilTs`)
    .get({ ruleId, actionId, untilTs, prefix: TIMED_RUN_PREFIX, mark: TIMED_RUN_ACTION_MARK }) as { n: number }).n;
}

/** A timed window an action failed and still owes: what the owner can see and retry. */
export interface FailedWindow {
  runId: number;
  ruleId: number;
  ruleName: string;
  actionId: string;
  sinceTs: number;
  untilTs: number;
  timing: TimedTriggerKind;
  /** When the run was claimed: where its result would have appeared among others. */
  claimedAt: number;
  /** Why the last attempt failed. */
  detail: string | null;
  failedAt: number;
  /** When the schedule tries again by itself; null once its attempts are spent. */
  retryAt: number | null;
}

/** Enabled rules' timed windows whose `type` action last failed and is still owed, oldest first. */
export function failedWindows(db: Db, type: string): FailedWindow[] {
  return db.prepare(
    `SELECT r.id AS runId, r.rule_id AS ruleId, rules.name AS ruleName, d.action_id AS actionId, d.since_ts AS sinceTs,
            COALESCE(r.window_until, r.at) AS untilTs, d.timing, r.at AS claimedAt, a.detail, a.at AS failedAt,
            CASE WHEN d.attempts < @max THEN d.retry_at END AS retryAt
     FROM rule_run_debts d JOIN rule_runs r ON r.id = d.run_id JOIN rules ON rules.id = r.rule_id AND rules.enabled = 1
       JOIN rule_action_runs a ON a.run_id = d.run_id AND a.action_id = d.action_id AND a.outcome = 'failed' AND a.kind = @type
     ORDER BY untilTs, r.id`,
  ).all({ type, max: TIMED_ATTEMPTS_MAX }) as FailedWindow[];
}

/**
 * Makes a failed `type` action's window payable now, with one more attempt when its own are spent: the owner asked.
 * The run's other waiting debts become payable too, since a run is paid whole. Returns the run's rule, or null when
 * it owes no such failure.
 */
export function retryDebtNow(db: Db, type: string, runId: number, actionId: string, now: number): number | null {
  const changed = db.prepare(
    `UPDATE rule_run_debts SET retry_at = @now, attempts = MIN(attempts, @max - 1)
     WHERE run_id = @runId AND (action_id = @actionId OR attempts < @max)
       AND EXISTS (SELECT 1 FROM rule_run_debts d JOIN rule_action_runs a ON a.run_id = d.run_id AND a.action_id = d.action_id
                   WHERE d.run_id = @runId AND d.action_id = @actionId AND a.kind = @type AND a.outcome = 'failed')`,
  ).run({ type, runId, actionId, now, max: TIMED_ATTEMPTS_MAX }).changes > 0;
  return changed ? (db.prepare('SELECT rule_id FROM rule_runs WHERE id = ?').pluck().get(runId) as number) : null;
}
