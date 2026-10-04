// Migration: every topic becomes a rule (its match plus an Alert action), rules started by topics take in their
// topics' match, alerts and Jev answers move to the rules, and the topics table goes. Frozen: it writes the rule JSON of
// spec format 2 itself, so later changes to the rule code can't change what it did. Never edit it; append a migration.
import type { Db } from './db';

type Json = Record<string, unknown>;

interface TopicRow {
  id: number;
  name: string;
  pattern: string;
  pattern_spec: string | null;
  description: string | null;
  jev_question: string | null;
  channel_ids: string | null;
  contains: string | null;
  cooldown_ms: number;
  notify: number;
  enabled: number;
  created_at: number;
  builtin: string | null;
}

interface RuleRow {
  id: number;
  name: string;
  spec: string;
  enabled: number;
  position: number;
  armed_at: number;
  discord_send: number;
  created_at: number;
}

const parse = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);
const nonEmpty = <T>(xs: T[] | null | undefined): T[] | null => (xs?.length ? xs : null);

/** A topic's match: keywords, plus its own Jev question or else its description (a question took precedence). */
function matchOf(t: TopicRow): Json {
  if (t.builtin) return {};
  const m: Json = {};
  if (t.pattern.trim()) m.text = { pattern: t.pattern, spec: parse(t.pattern_spec) };
  const question = parse<Json>(t.jev_question);
  if (question) m.jev = question;
  else if (t.description?.trim()) m.meaning = t.description.trim();
  return m;
}

const narrowOf = (t: TopicRow): Json => {
  const contains = nonEmpty(parse<string[]>(t.contains));
  return !t.builtin && contains ? { contains } : {};
};

/** Rule JSON format 1's actions without their backfill flags, a notify's toast without its own. */
const v2Actions = (actions: Json[]): Json[] =>
  actions.map(({ backfill: _backfill, ...a }) => (a.kind === 'notify' ? { ...a, toast: a.toast ? { cooldownMs: (a.toast as Json).cooldownMs } : null } : a));

/** Both lists narrow, so a channel must be in each; one list alone narrows by itself. */
function channelsOf(ruleIds: string[] | null, topicIds: string[] | null): { ids: string[] | null; none: boolean } {
  if (!ruleIds || !topicIds) return { ids: ruleIds ?? topicIds, none: false };
  const ids = ruleIds.filter((id) => topicIds.includes(id));
  return { ids, none: ids.length === 0 };
}

const pick = (src: Json, keys: string[]): Json => Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));

export function topicsIntoRules(db: Db): void {
  db.exec('ALTER TABLE rules ADD COLUMN builtin TEXT');
  const topics = db.prepare('SELECT * FROM topics ORDER BY created_at, id').all() as TopicRow[];
  const byId = new Map(topics.map((t) => [t.id, t]));
  const oldRules = db.prepare('SELECT * FROM rules ORDER BY position, id').all() as RuleRow[];
  let position = oldRules.reduce((max, r) => Math.max(max, r.position), 0);
  const insert = db.prepare('INSERT INTO rules (name, spec, enabled, position, armed_at, discord_send, created_at, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  // Each topic: a rule armed when the topic was made, taking missed messages as topics did, alerting as it notified.
  const ruleOf = new Map<number, number>();
  for (const t of topics) {
    const match = matchOf(t);
    const narrow = narrowOf(t);
    const channelIds = nonEmpty(parse<string[]>(t.channel_ids));
    const spec = {
      v: 2,
      trigger: { kind: 'message' },
      gates: { ...(channelIds ? { channelIds } : {}), edits: false, missed: true },
      match,
      narrow,
      actions: [{ id: 'alert', kind: 'notify', toast: t.notify ? { cooldownMs: t.cooldown_ms } : null }],
    };
    // A topic with nothing to match never matched; as a rule it would match every message, so it stays off.
    const matchesNothing = !t.builtin && !Object.keys(match).length && !Object.keys(narrow).length;
    const id = insert.run(t.name, JSON.stringify(spec), matchesNothing ? 0 : t.enabled, ++position, t.created_at, 0, t.created_at, t.builtin).lastInsertRowid;
    ruleOf.set(t.id, Number(id));
  }

  // Rules started by topics: one rule per topic, each taking in that topic's scope, match and contents.
  const update = db.prepare('UPDATE rules SET spec = ?, enabled = ?, name = ? WHERE id = ?');
  for (const r of oldRules) {
    const spec = JSON.parse(r.spec) as Json;
    const trigger = spec.trigger as Json;
    if (spec.v !== 1 || trigger.kind !== 'topicMatch') continue;
    const c = (spec.conditions ?? {}) as Json;
    const actions = spec.actions as Json[];
    const topicIds = (trigger.topicIds as number[]).filter((id) => byId.has(id));
    if (!topicIds.length) {
      // Its topics are gone: it could never fire again. Kept, off, so its actions aren't lost.
      update.run(JSON.stringify({ v: 2, trigger: { kind: 'message' }, gates: { edits: false, missed: false }, match: {}, narrow: {}, actions: v2Actions(actions) }), 0, `${r.name} (its topic is gone)`, r.id);
      continue;
    }
    topicIds.forEach((topicId, i) => {
      const t = byId.get(topicId)!;
      const channels = channelsOf(nonEmpty(c.channelIds as string[] | undefined), nonEmpty(parse<string[]>(t.channel_ids)));
      const topicMatch = matchOf(t);
      // The rule's own keyword or Jev condition applies only where the topic brings no match of its own (AND can't be kept).
      const match = Object.keys(topicMatch).length ? topicMatch : pick(c, ['text', 'jev']);
      const narrow = { ...narrowOf(t), ...pick(c, ['contains', 'linkPlatforms', 'linkDomains', 'tagIds']) };
      const out = {
        v: 2,
        trigger: { kind: 'message' },
        gates: { ...pick(c, ['guildIds', 'authorIds', 'authorsNot']), ...(channels.ids ? { channelIds: channels.ids } : {}), edits: false, missed: actions.some((a) => a.backfill === true) },
        match,
        narrow,
        actions: v2Actions(actions),
      };
      // A built-in topic's match can't be a user rule's, and disjoint channels never matched: kept off, for the owner to redo.
      const broken = !!t.builtin || channels.none;
      const enabled = broken ? 0 : r.enabled;
      const name = broken ? `${r.name} (redo its match)` : i === 0 ? r.name : `${r.name} (${t.name})`;
      if (i === 0) update.run(JSON.stringify(out), enabled, name, r.id);
      else insert.run(name, JSON.stringify(out), enabled, ++position, r.armed_at, r.discord_send, r.created_at, null);
    });
  }

  // Alerts: every one belongs to a rule now. Ids are kept, so duplicate_of links still hold.
  db.exec(`
    CREATE TABLE alerts_rules (id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
                               message_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, ts INTEGER NOT NULL,
                               snippet TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
                               match_kind TEXT NOT NULL DEFAULT 'pattern', probability REAL, duplicate_of INTEGER,
                               UNIQUE (rule_id, message_id));
    -- 'rule' (a rule's own alert) is 'pattern' now: matched by the rule itself, not by Jev.
    INSERT INTO alerts_rules (id, rule_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of)
      SELECT id, rule_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at,
             CASE match_kind WHEN 'rule' THEN 'pattern' ELSE match_kind END, probability, duplicate_of
      FROM alerts WHERE rule_id IS NOT NULL;
  `);
  const moveAlerts = db.prepare(
    `INSERT OR IGNORE INTO alerts_rules (id, rule_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of)
     SELECT id, ?, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of FROM alerts WHERE topic_id = ?`,
  );
  const moveJudgments = db.prepare('UPDATE jev_judgments SET subject = ? WHERE subject = ?');
  for (const [topicId, ruleId] of ruleOf) {
    moveAlerts.run(ruleId, topicId);
    moveJudgments.run(`rule:${ruleId}`, `topic:${topicId}`);
  }
  db.exec(`
    DROP TABLE alerts;
    ALTER TABLE alerts_rules RENAME TO alerts;
    CREATE INDEX alerts_ts ON alerts(ts);
    CREATE INDEX alerts_unread ON alerts(read_at) WHERE read_at IS NULL;
    CREATE UNIQUE INDEX rules_builtin ON rules(builtin) WHERE builtin IS NOT NULL;
    DROP TABLE topics;
  `);
}
