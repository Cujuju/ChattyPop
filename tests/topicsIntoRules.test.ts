import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db';
import { topicsIntoRules } from '../src/core/topicsIntoRules';
import { applyMigrations, migrationIndex, tempDir } from './helpers';

const ASK = { type: 'noul', question: 'Selling?', yes: '', no: '', minProbability: 0.6 };
const SPEC = { anyOf: ['gb'], allOf: [], noneOf: [], wholeWords: true, matchCase: false };

let db: Db;
beforeEach(() => {
  db = new Database(join(tempDir(), 'old.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, 0, migrationIndex(topicsIntoRules));
});

interface TopicSeed {
  id: number;
  name: string;
  pattern?: string;
  description?: string | null;
  jev?: object | null;
  channels?: string[] | null;
  contains?: string[] | null;
  cooldown?: number;
  notify?: boolean;
  enabled?: boolean;
  createdAt?: number;
  builtin?: string | null;
  spec?: object | null;
}
const topic = (t: TopicSeed): void => {
  db.prepare(
    `INSERT INTO topics (id, name, pattern, pattern_spec, description, jev_question, channel_ids, contains, cooldown_ms, notify, enabled, created_at, builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.name,
    t.pattern ?? '',
    t.spec ? JSON.stringify(t.spec) : null,
    t.description ?? null,
    t.jev ? JSON.stringify(t.jev) : null,
    t.channels ? JSON.stringify(t.channels) : null,
    t.contains ? JSON.stringify(t.contains) : null,
    t.cooldown ?? 0,
    t.notify === false ? 0 : 1,
    t.enabled === false ? 0 : 1,
    t.createdAt ?? 1,
    t.builtin ?? null,
  );
};
const v1Rule = (id: number, name: string, spec: object, o: { enabled?: boolean; discordSend?: boolean } = {}): void => {
  db.prepare(
    'INSERT INTO rules (id, name, spec, enabled, position, armed_at, discord_send, created_at) VALUES (?, ?, ?, ?, ?, 50, ?, 40)',
  ).run(id, name, JSON.stringify({ v: 1, ...spec }), o.enabled === false ? 0 : 1, id, o.discordSend ? 1 : 0);
};
const alert = (id: number, owner: { topic: number } | { rule: number }, messageId: string, kind = 'pattern'): void => {
  db.prepare(
    `INSERT INTO alerts (id, topic_id, rule_id, message_id, channel_id, author_id, ts, snippet, created_at, read_at, match_kind, probability, duplicate_of)
     VALUES (?, ?, ?, ?, 'c1', 'u', 5, 's', 6, NULL, ?, NULL, NULL)`,
  ).run(id, 'topic' in owner ? owner.topic : null, 'rule' in owner ? owner.rule : null, messageId, kind);
};
const migrate = (): void => applyMigrations(db, migrationIndex(topicsIntoRules));

interface Row {
  id: number;
  name: string;
  enabled: number;
  armed_at: number;
  created_at: number;
  builtin: string | null;
  spec: Record<string, unknown>;
}
const rules = (): Row[] =>
  (
    db
      .prepare('SELECT id, name, enabled, armed_at, created_at, builtin, spec FROM rules ORDER BY position')
      .all() as (Omit<Row, 'spec'> & { spec: string })[]
  ).map((r) => ({
    ...r,
    spec: JSON.parse(r.spec) as Record<string, unknown>,
  }));
const byName = (name: string): Row => rules().find((r) => r.name === name)!;
/** A v1 action the upgrades carry through untouched, its other fields becoming its config. */
const ACTION = { id: 'act', kind: 'probe.act', setting: 'x' };

describe('topics becoming rules', () => {
  it('maps each field: keywords, meaning or its own question, channels, contents, notifications, armed when made', () => {
    topic({
      id: 1,
      name: 'gb',
      pattern: 'gb',
      spec: SPEC,
      description: 'group buys',
      channels: ['c1'],
      contains: ['link'],
      cooldown: 60_000,
      createdAt: 7,
    });
    topic({ id: 2, name: 'sales', description: 'sales', jev: ASK, notify: false, enabled: false });
    migrate();
    expect(byName('gb')).toMatchObject({
      enabled: 1,
      armed_at: 7,
      created_at: 7,
      builtin: null,
      spec: {
        v: 4,
        trigger: { type: 'message', config: null },
        gates: { channelIds: ['c1'], edits: false, missed: true },
        match: [
          { type: 'text', config: { pattern: 'gb', spec: SPEC } },
          { type: 'meaning', config: 'group buys' },
        ],
        narrow: [{ type: 'contains', config: ['link'] }],
        actions: [{ id: 'alert', type: 'alerts.notify', config: { toast: { cooldownMs: 60_000 } } }],
      },
    });
    // Its own question took precedence over the description; "Never" notifications is an Alert without a toast.
    expect(byName('sales')).toMatchObject({
      enabled: 0,
      spec: {
        match: [{ type: 'jev', config: ASK }],
        actions: [{ id: 'alert', type: 'alerts.notify', config: { toast: null } }],
      },
    });
  });

  it('keeps built-ins built in with their managed match, and turns off a topic that matched nothing', () => {
    topic({ id: 1, name: 'Aimed at you', builtin: 'aimed_at_me', pattern: 'ignored', contains: ['link'] });
    topic({ id: 2, name: 'empty' });
    migrate();
    expect(byName('Aimed at you')).toMatchObject({
      builtin: 'aimed_at_me',
      spec: { match: [{ type: 'alerts.aimed', config: null }], narrow: [] },
    });
    expect(byName('empty').enabled).toBe(0);
    expect(() =>
      db
        .prepare(
          "INSERT INTO rules (name, spec, position, armed_at, created_at, builtin) VALUES ('x', '{}', 9, 0, 0, 'aimed_at_me')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('moves topic alerts to their rules with ids kept, turns rule alerts into pattern ones, and renames Jev subjects', () => {
    topic({ id: 4, name: 'gb', pattern: 'gb' });
    v1Rule(1, 'mine', {
      trigger: { kind: 'message', edits: false },
      conditions: {},
      actions: [{ id: 'n', kind: 'notify', backfill: true, toast: null }],
    });
    alert(10, { topic: 4 }, 'm1', 'meaning');
    alert(11, { rule: 1 }, 'm2', 'rule');
    db.prepare(
      "INSERT INTO jev_judgments (message_id, subject, value, model, judged_at) VALUES ('m1', 'topic:4', 0.9, 'x', 1)",
    ).run();
    migrate();
    const gb = byName('gb').id;
    expect(db.prepare('SELECT id, rule_id, message_id, match_kind FROM alerts ORDER BY id').all()).toEqual([
      { id: 10, rule_id: gb, message_id: 'm1', match_kind: 'meaning' },
      { id: 11, rule_id: 1, message_id: 'm2', match_kind: 'pattern' },
    ]);
    expect(db.prepare('SELECT subject FROM jev_judgments').pluck().all()).toEqual([`rule:${gb}`]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'topics'").get()).toBeUndefined();
    // Every alert belongs to a rule now.
    expect(() =>
      db
        .prepare(
          "INSERT INTO alerts (message_id, channel_id, author_id, ts, snippet, created_at) VALUES ('m', 'c', 'u', 1, 's', 1)",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });

  it('upgrades plain v1 rules as they are', () => {
    v1Rule(1, 'mine', {
      trigger: { kind: 'message', edits: true },
      conditions: { text: { pattern: 'x', spec: null } },
      actions: [{ id: 'n', kind: 'notify', backfill: true, toast: { cooldownMs: 5, backfill: true } }],
    });
    migrate();
    expect(byName('mine').spec.v).toBe(4);
  });
});

describe('rules started by topics', () => {
  it('become one rule per topic, taking in its match; the rule keeps its own narrowing and actions', () => {
    topic({ id: 1, name: 'boats', pattern: 'boat', channels: ['c1', 'c2'] });
    topic({ id: 2, name: 'cars', description: 'cars' });
    v1Rule(
      5,
      'post it',
      {
        trigger: { kind: 'topicMatch', topicIds: [1, 2] },
        conditions: { channelIds: ['c2', 'c3'], contains: ['voice'] },
        actions: [ACTION],
      },
      { discordSend: true },
    );
    migrate();
    expect(byName('post it')).toMatchObject({
      id: 5,
      enabled: 1,
      spec: {
        gates: { channelIds: ['c2'], edits: false, missed: false },
        match: [{ type: 'text', config: { pattern: 'boat', spec: null } }],
        narrow: [{ type: 'contains', config: ['voice'] }],
        actions: [{ id: ACTION.id, type: ACTION.kind, config: { setting: ACTION.setting } }],
      },
    });
    expect(byName('post it (cars)')).toMatchObject({
      enabled: 1,
      armed_at: 50,
      spec: {
        gates: { channelIds: ['c2', 'c3'] },
        match: [{ type: 'meaning', config: 'cars' }],
        narrow: [{ type: 'contains', config: ['voice'] }],
        actions: [{ id: ACTION.id, type: ACTION.kind, config: { setting: ACTION.setting } }],
      },
    });
    expect(db.prepare("SELECT discord_send FROM rules WHERE name = 'post it (cars)'").pluck().get()).toBe(1);
  });

  it("keeps the rule's own keywords only where its topic brings no match", () => {
    topic({ id: 1, name: 'voice', contains: ['voice'] });
    v1Rule(5, 'r', {
      trigger: { kind: 'topicMatch', topicIds: [1] },
      conditions: { text: { pattern: 'noon', spec: null } },
      actions: [ACTION],
    });
    migrate();
    expect(byName('r').spec).toMatchObject({
      match: [{ type: 'text', config: { pattern: 'noon', spec: null } }],
      narrow: [{ type: 'contains', config: ['voice'] }],
    });
  });

  it('turns off, renamed, one that can never match: a built-in topic, disjoint channels or topics gone', () => {
    topic({ id: 1, name: 'Aimed at you', builtin: 'aimed_at_me' });
    topic({ id: 2, name: 'here', pattern: 'x', channels: ['c1'] });
    v1Rule(5, 'aimed', { trigger: { kind: 'topicMatch', topicIds: [1] }, conditions: {}, actions: [ACTION] });
    v1Rule(6, 'apart', {
      trigger: { kind: 'topicMatch', topicIds: [2] },
      conditions: { channelIds: ['c9'] },
      actions: [ACTION],
    });
    v1Rule(7, 'orphan', { trigger: { kind: 'topicMatch', topicIds: [99] }, conditions: {}, actions: [ACTION] });
    migrate();
    expect(
      rules()
        .filter((r) => r.builtin === null && r.enabled === 0)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['aimed (redo its match)', 'apart (redo its match)', 'orphan (its topic is gone)']);
  });
});
