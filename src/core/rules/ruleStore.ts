// Rules as stored, their runs, and each action's outcome: the stored side of the rule engine.
import type { Rule, RuleInput, RuleOutcome, RuleRun, RuleSpec } from '@shared/rules';
import { newRuleInput, parseRuleSpec, upgradeRuleSpec, validateRuleInput } from '@shared/ruleSpec';
import { ruleUnavailable, switchState } from '@shared/ruleAvailability';
import { getSetting } from '../db';
import { ruleKind } from '@shared/ruleKinds';
import { TIMED_CATCH_UP_PREFIX, TIMED_RUN_ACTION_MARK, TIMED_RUN_PREFIX } from '@shared/ruleTime';
import { snippet } from '../queries/snippet';
import type { Db } from '../db';
import { rawJsonSql } from '../queries/messageContent';
import { mentionsFrom } from '../queries/messageExtras';
import { displayNameSql } from '../queries/names';
import { visibleMessageRefSql } from '../queries/privacy';

/** Rule columns as stored in the archive database. */
export interface RuleRow {
  id: number;
  name: string;
  /** RuleSpec as JSON. */
  spec: string;
  enabled: number;
  position: number;
  armed_at: number;
  discord_send: number;
  created_at: number;
  builtin: string | null;
}

/** A stored rule ready to run: its spec read, or why it can't be. */
export interface LoadedRule {
  row: RuleRow;
  spec: RuleSpec | null;
  error: string | null;
}

/** Reads a stored rule, retaining a parse error when its structure is invalid. */
export function loadRule(row: RuleRow): LoadedRule {
  try {
    return { row, spec: parseRuleSpec(row.spec, row.builtin), error: null };
  } catch (err) {
    return { row, spec: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** An unreadable rule's spec as far as it parses, so the editor can show it; a new rule's when it doesn't. */
function storedShape(json: string, builtin: string | null): RuleSpec {
  try {
    return upgradeRuleSpec(json, builtin);
  } catch {
    try {
      return JSON.parse(json) as RuleSpec;
    } catch {
      return newRuleInput().spec;
    }
  }
}

/** A rule's readable spec; null when it is gone or can't be read. */
export function storedSpec(db: Db, id: number): RuleSpec | null {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow | undefined;
  return row ? loadRule(row).spec : null;
}

/** The id of the rule stored under a managed key, or null. */
export function managedRuleId(db: Db, key: string): number | null {
  const row = db.prepare('SELECT id FROM rules WHERE builtin = ?').get(key) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Every rule in run order. */
export const ruleRows = (db: Db): RuleRow[] =>
  db.prepare('SELECT * FROM rules ORDER BY position, id').all() as RuleRow[];

/** Every rule with how often it fired, in run order. A rule whose spec can't be read keeps its stored JSON's shape where possible. */
export function listRules(db: Db): Rule[] {
  const stats = new Map(
    (
      db.prepare('SELECT rule_id AS id, COUNT(*) AS fired, MAX(at) AS last FROM rule_runs GROUP BY rule_id').all() as {
        id: number;
        fired: number;
        last: number;
      }[]
    ).map((s) => [s.id, s]),
  );
  return ruleRows(db).map((row) => {
    const { spec, error } = loadRule(row);
    const s = stats.get(row.id);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      discordSend: row.discord_send === 1,
      spec: spec ?? storedShape(row.spec, row.builtin),
      position: row.position,
      armedAt: row.armed_at,
      createdAt: row.created_at,
      builtin: row.builtin,
      // The switch alone: the engine's kinds add a plugin that failed to start (RuleService).
      error: error ?? (spec ? ruleUnavailable(spec, (id) =>
        switchState(!((getSetting(db, 'plugins.disabled') as string[] | undefined) ?? []).includes(id))) : null),
      fired: s?.fired ?? 0,
      lastFiredAt: s?.last ?? null,
    };
  });
}

/** Stores a new rule, last in run order and armed at `armedAt` (now by default); returns its id. Throws with a message for the editor. */
export function insertRule(db: Db, input: RuleInput, now: number, builtin: string | null = null, armedAt = now): number {
  validateRuleInput(input, builtin);
  const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules').get() as { p: number }).p;
  return Number(
    db
      .prepare(
        'INSERT INTO rules (name, spec, enabled, position, armed_at, discord_send, created_at, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.name.trim(),
        JSON.stringify(input.spec),
        input.enabled ? 1 : 0,
        position,
        armedAt,
        input.discordSend ? 1 : 0,
        now,
        builtin,
      ).lastInsertRowid,
  );
}

/** What an edit changed that stored matches depend on. */
export interface RuleEdit {
  /** What Jev is asked (meaning, the owner's question) or who it's asked about: its stored answers and Jev alerts go. */
  jevChanged: boolean;
  matchChanged: boolean;
}

/** Re-enabling rules re-arms them to exclude disabled-period messages. Built-in on/off remains controlled by its Jev switch. */
export function updateRule(db: Db, id: number, input: RuleInput, now: number): RuleEdit {
  const old = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow | undefined;
  if (!old) throw new Error('That rule no longer exists.');
  validateRuleInput(input, old.builtin);
  const previous = loadRule(old).spec;
  if (old.builtin && ['trigger', 'match', 'narrow'].some((key) =>
    JSON.stringify(previous?.[key as keyof RuleSpec]) !== JSON.stringify(input.spec[key as keyof RuleSpec])))
    throw new Error('A managed rule keeps its trigger, match and narrowing.');
  const enabled = old.builtin ? old.enabled === 1 : input.enabled;
  const armedAt = old.enabled === 1 || !enabled ? old.armed_at : now;
  db.prepare('UPDATE rules SET name = ?, spec = ?, enabled = ?, armed_at = ?, discord_send = ? WHERE id = ?').run(
    input.name.trim(),
    JSON.stringify(input.spec),
    enabled ? 1 : 0,
    armedAt,
    input.discordSend ? 1 : 0,
    id,
  );
  const was = loadRule(old).spec;
  return {
    jevChanged: questionSignature(was) !== questionSignature(input.spec),
    matchChanged:
      JSON.stringify([was?.match, was?.narrow, was?.gates]) !==
      JSON.stringify([input.spec.match, input.spec.narrow, input.spec.gates]),
  };
}

/** Deletes a rule and its cascading run records. */
export function deleteRule(db: Db, id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id); // runs cascade
}

/** Claims one event for a rule; returns the run id, or null when the rule already fired on it. */
export function claimRun(
  db: Db,
  ruleId: number,
  eventKey: string,
  m: { id: string; channelId: string } | null,
  live: boolean,
  now: number,
): number | null {
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO rule_runs (rule_id, event_key, message_id, channel_id, live, at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(ruleId, eventKey, m?.id ?? null, m?.channelId ?? null, live ? 1 : 0, now);
  return info.changes ? Number(info.lastInsertRowid) : null;
}

/** Stores or replaces the outcome of one action in a claimed run; `satOut`: its plugin was off, so the run owes it still. */
export function recordOutcome(
  db: Db,
  runId: number,
  actionId: string,
  kind: string,
  outcome: RuleOutcome,
  detail: string | null,
  now: number,
  satOut = false,
): void {
  db.prepare(
    `INSERT INTO rule_action_runs (run_id, action_id, kind, outcome, detail, at, sat_out) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, action_id) DO UPDATE SET outcome = excluded.outcome, detail = excluded.detail, at = excluded.at, sat_out = excluded.sat_out`,
  ).run(runId, actionId, kind, outcome, detail, now, satOut ? 1 : 0);
}

/** A run in which action `@actionId` sat out. */
const SAT_OUT = `EXISTS (SELECT 1 FROM rule_action_runs a WHERE a.run_id = rule_runs.id AND a.action_id = @actionId AND a.sat_out = 1)`;

/** Returns a timed action’s latest applicable execution. Excludes pre-trigger-change message runs and runs skipped while its plugin was disabled. */
export function lastTimedRun(db: Db, ruleId: number, actionId: string): number | null {
  const r = db
    .prepare(
      `SELECT MAX(at) AS at FROM rule_runs WHERE rule_id = @ruleId AND substr(event_key, 1, length(@prefix)) = @prefix
         AND (instr(event_key, @mark) = 0 OR substr(event_key, instr(event_key, @mark) + 1) = @actionId) AND NOT ${SAT_OUT}`,
    )
    .get({ ruleId, prefix: TIMED_RUN_PREFIX, mark: TIMED_RUN_ACTION_MARK, actionId }) as { at: number | null };
  return r.at;
}

/**
 * When a timed rule last ran on schedule (any of its actions), or null: an action catching up alone doesn't count, nor a
 * run every action sat out.
 */
export function lastScheduledRun(db: Db, ruleId: number): number | null {
  const r = db
    .prepare(
      `SELECT MAX(at) AS at FROM rule_runs WHERE rule_id = @ruleId AND substr(event_key, 1, length(@prefix)) = @prefix
         AND substr(event_key, 1, length(@catchUp)) != @catchUp
         AND (NOT EXISTS (SELECT 1 FROM rule_action_runs a WHERE a.run_id = rule_runs.id AND a.sat_out = 1)
              OR EXISTS (SELECT 1 FROM rule_action_runs a WHERE a.run_id = rule_runs.id AND a.sat_out = 0))`,
    )
    .get({ ruleId, prefix: TIMED_RUN_PREFIX, catchUp: TIMED_CATCH_UP_PREFIX }) as { at: number | null };
  return r.at;
}

/** When this rule's action last ran to completion, or null. */
export function lastDone(db: Db, ruleId: number, actionId: string): number | null {
  const r = db
    .prepare(
      `SELECT MAX(a.at) AS at FROM rule_action_runs a JOIN rule_runs r ON r.id = a.run_id WHERE r.rule_id = ? AND a.action_id = ? AND a.outcome = 'done'`,
    )
    .get(ruleId, actionId) as { at: number | null };
  return r.at;
}

/** Actions of `kind` attempted (done or failed, not skipped) since `sinceTs`, across every rule. */
export const countAttemptsSince = (db: Db, kind: string, sinceTs: number): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rule_action_runs WHERE kind = ? AND outcome != 'skipped' AND at >= ?`)
      .get(kind, sinceTs) as { n: number }
  ).n;

/** How much of a run's message Settings → Rules shows: one line of its table. */
const RUN_SNIPPET_CHARS = 140;

/** A rule's latest runs, newest first, less those about messages privacy mode hides. */
export function ruleRuns(db: Db, ruleId: number, limit: number): RuleRun[] {
  const runs = db
    .prepare(
      `SELECT r.id, r.rule_id AS ruleId, r.message_id AS messageId, r.channel_id AS channelId, c.name AS channelName,
              CASE WHEN m.id IS NULL THEN NULL ELSE ${displayNameSql('m.author_id', 'm.channel_id')} END AS authorName,
              m.content AS content, ${rawJsonSql('$.mentions')} AS mentionsJson, r.live, r.at
       FROM rule_runs r LEFT JOIN channels c ON c.id = r.channel_id
       LEFT JOIN messages m ON m.id = r.message_id LEFT JOIN users u ON u.id = m.author_id
       WHERE r.rule_id = ? AND (r.channel_id IS NULL OR ${visibleMessageRefSql('r.channel_id', 'r.message_id')})
       ORDER BY r.at DESC, r.id DESC LIMIT ?`,
    )
    .all(ruleId, limit) as (Omit<RuleRun, 'live' | 'actions' | 'snippet' | 'mentions'> & {
    live: number;
    content: string | null;
    mentionsJson: string | null;
  })[];
  // First-recorded order determines runs. Millisecond timestamps can tie and change after later outcomes.
  const actions = db.prepare(
    'SELECT action_id AS actionId, kind, outcome, detail FROM rule_action_runs WHERE run_id = ? ORDER BY rowid',
  );
  return runs.map(({ content, mentionsJson, ...r }) => ({
    ...r,
    snippet: content === null ? null : snippet(content, null, RUN_SNIPPET_CHARS),
    mentions: mentionsFrom(mentionsJson),
    live: r.live === 1,
    actions: actions.all(r.id) as RuleRun['actions'],
  }));
}

/** The question and context whose stored Jev answers must be replaced after an edit. */
export const questionSignature = (s: RuleSpec | null): string =>
  JSON.stringify([
    s?.match.filter((p) => ruleKind('match', p.type)?.asksJev) ?? null,
    s?.gates.channelIds ?? null,
    s?.narrow.find((p) => p.type === 'contains')?.config ?? null,
  ]);
