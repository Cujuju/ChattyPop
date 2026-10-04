// Contract tests for jev queries.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JEV_QUERIES, jevQueryDef, validateJevQuery, type JevQueryDef, type JevQueryUse } from '@shared/jevQueries';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { ruleSubject } from '@shared/rules';
import { MS_PER_DAY } from '@shared/units';
import type { Db } from '../src/core/db';
import { NOTABLE_QUERY, NOTABLE_SUBJECT } from '../src/core/jev/notable';
import { QUERY } from '../src/core/jev/questions';
import { TAG_QUERY } from '../src/core/jev/tags';
import { jevQuery, queryMatch, queryRequest, setJevQueryOverrides } from '../src/core/jev/queries';
import { rerunMessages, rerunSubjects } from '../src/core/jev/rerun';
import { jevQueryHandlers } from '../src/core/jevQueryHandlers';
import { directory } from '../src/core/queries/directory';
import { score } from './fakeJev';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { probeRule, ruleHarness, type Harness } from './ruleHarness';
import { ARRIVAL } from '../src/core/arrival';

const def = (id: string) => jevQueryDef(id)!;
/** A query as a plugin would declare it, read as `use` says. */
const declared = (use: JevQueryUse, defaults: CustomJevQuestion, placeholders?: string[]): JevQueryDef => ({
  id: `r2.${use}`,
  group: 'Messages',
  label: use,
  features: [],
  sees: '',
  use,
  placeholders,
  condition: 'Count',
  defaults,
});

let db: Db;
beforeEach(() => {
  db = tempDb();
  setJevQueryOverrides({});
});
afterEach(() => setJevQueryOverrides({}));

describe('Jev query catalog', () => {
  it('every default passes its own checks and ids are unique', () => {
    for (const q of JEV_QUERIES) expect(() => validateJevQuery(q, q.defaults), q.id).not.toThrow();
    expect(new Set(JEV_QUERIES.map((q) => q.id)).size).toBe(JEV_QUERIES.length);
  });

  it('locks what the app reads: option names, level count, type, placeholders', () => {
    const named = declared('fixed-options', {
      type: 'choice',
      question: 'What is `message`?',
      options: [{ name: 'plan', description: 'A plan' }, { name: 'none', description: '' }],
      alertOn: ['plan'],
      minProbability: 0.5,
    });
    const plans = named.defaults as Extract<CustomJevQuestion, { type: 'choice' }>;
    expect(() => validateJevQuery(named, { ...plans, options: plans.options.map((o, i) => (i ? o : { ...o, name: 'todo' })) })).toThrow(/names/);
    expect(() => validateJevQuery(named, { ...plans, options: plans.options.map((o) => ({ ...o, description: 'x' })) })).not.toThrow();
    const levelled = declared('fixed-levels', { type: 'score', question: 'How worth it is `message`?', levels: ['low', 'mid', 'high'], minScore: 1 });
    const worth = levelled.defaults as Extract<CustomJevQuestion, { type: 'score' }>;
    expect(() => validateJevQuery(levelled, { ...worth, levels: worth.levels.slice(1) })).toThrow(/levels/);
    const ranked = declared('rank', { type: 'noul', question: 'Does {ref} answer it?', yes: '', no: '', minProbability: 0.5 });
    expect(() => validateJevQuery(ranked, { type: 'choice', question: 'c {ref}?', options: [{ name: 'a', description: '' }, { name: 'b', description: '' }], alertOn: ['a'], minProbability: 0.5 })).toThrow(/must stay/);
    const filled = declared('decision', { type: 'noul', question: 'Is line {k} filler?', yes: '', no: '', minProbability: 0.5 }, ['{k}']);
    expect(() => validateJevQuery(filled, { ...filled.defaults, question: 'Is it filler?' })).toThrow(/\{k\}/);
    const tags = def('messages.tags').defaults as Extract<CustomJevQuestion, { type: 'choice' }>;
    expect(() => validateJevQuery(def('messages.tags'), { ...tags, options: [...tags.options, { name: 'meme', description: '' }], alertOn: [...tags.alertOn, 'meme'] })).not.toThrow();
  });

  it('a decision query may change type; its condition follows', () => {
    const s: CustomJevQuestion = { type: 'score', question: 'How notable is `message`?', levels: ['no', 'somewhat', 'very'], minScore: 2 };
    setJevQueryOverrides({ 'messages.notable': s });
    expect(queryRequest('messages.notable')).toEqual({ type: 'score', instructions: 'How notable is `message`?', criteria: ['no', 'somewhat', 'very'] });
    expect(queryMatch('messages.notable', score(2, { 2: 0.8 }) as never)).toBe(0.8);
    expect(queryMatch('messages.notable', score(1, { 1: 1 }) as never)).toBeNull();
    expect(queryMatch('messages.notable', { type: 'noul', noul: 0.99 })).toBeNull(); // an old-type answer never matches
  });

  it('an edit made invalid falls back to the default rather than breaking the feature', () => {
    // Tags are read as labels, so the query must stay pick-one.
    setJevQueryOverrides({ [TAG_QUERY]: { type: 'noul', question: 'Tagged?', yes: '', no: '', minProbability: 0.5 } });
    expect(jevQuery(TAG_QUERY)).toBe(def(TAG_QUERY).defaults);
  });

  it('fills placeholders and vars', () => {
    setJevQueryOverrides({ [NOTABLE_QUERY]: { type: 'noul', question: 'Is links.{ref} spam?', yes: '', no: '', minProbability: 0.5 } });
    expect(queryRequest(NOTABLE_QUERY, { placeholders: { '{ref}': 'l3' } })).toMatchObject({ instructions: 'Is links.l3 spam?' });
    expect(queryRequest('rules.meaning', { vars: { topic: 'keyboards' } })).toMatchObject({ instructions: { topic: 'keyboards', question: expect.stringContaining('`topic`') } });
  });
});

describe('edited queries drive the features', () => {
  it('catch-up badges count by the edited condition, whatever the type', () => {
    const archive = seedArchive(db, [{ id: 'c1' }]);
    const [a, b] = [rawMessage('c1', Date.now(), 'a'), rawMessage('c1', Date.now() + 1, 'b')];
    archive.ingestMessages([a, b], ARRIVAL.gateway);
    const store = db.prepare('INSERT INTO jev_judgments (message_id, subject, value, label, model, judged_at) VALUES (?, ?, ?, ?, ?, 0)');
    store.run(a.id, NOTABLE_SUBJECT, 0.8, 'yes', 'm');
    store.run(b.id, NOTABLE_SUBJECT, 0.8, 'no', 'm');
    const notable = (): number => directory(db, 0).flatMap((g) => g.channels).find((c) => c.id === 'c1')!.notableCount;
    expect(notable()).toBe(0); // default is yes/no; choice rows don't count
    setJevQueryOverrides({
      'messages.notable': { type: 'choice', question: 'Notable?', options: [{ name: 'yes', description: '' }, { name: 'no', description: '' }], alertOn: ['yes'], minProbability: 0.7 },
    });
    expect(notable()).toBe(1);
  });

  it('saving validates, stores and applies; null resets', () => {
    const h = jevQueryHandlers(
      () => db,
      () => {
        throw new Error('unused');
      },
    );
    const tags = def(TAG_QUERY).defaults as Extract<CustomJevQuestion, { type: 'choice' }>;
    expect(() => h.setJevQuery(TAG_QUERY, { ...tags, options: [] })).toThrow();
    h.setJevQuery(TAG_QUERY, { ...tags, minProbability: 0.9 });
    expect(h.jevQueryOverrides()).toHaveProperty([TAG_QUERY]);
    expect((jevQuery(TAG_QUERY) as { minProbability: number }).minProbability).toBe(0.9);
    h.setJevQuery(TAG_QUERY, null);
    expect(jevQuery(TAG_QUERY)).toBe(tags);
  });
});

describe('run on past messages', () => {
  let h: Harness;
  let meaning: number;
  let asked: number;
  beforeEach(() => {
    h = ruleHarness();
    db = h.db;
    h.jev.on.topicMeaning = true;
    h.jev.on.ruleQuestions = true;
    meaning = h.rules.create(probeRule({ meaning: 'keyboards' }));
    asked = h.rules.create(probeRule({ jev: { type: 'noul', question: 'Keyboards?', yes: '', no: '', minProbability: 0.5 } }));
    db.prepare("UPDATE channels SET local_ai_only = 1 WHERE id = 'c2'").run();
    const old = Date.now() - 10 * MS_PER_DAY;
    h.archive.ingestMessages([rawMessage('c1', old, 'anyone know a good keyboard?'), rawMessage('c1', old + 1, 'lol'), rawMessage('c2', old + 2, 'secret?')], ARRIVAL.gateway);
    h.jev.requests = [];
  });

  it('asks only the chosen query, only in range, never local-only channels; old matches land as history', async () => {
    const req = { queryId: QUERY.meaning, channelId: null, fromTs: Date.now() - 11 * MS_PER_DAY, toTs: Date.now() };
    expect(rerunMessages(db, req)).toHaveLength(2);
    expect(rerunSubjects(db, req.queryId)).toEqual(new Set([ruleSubject(meaning)]));
    h.jev.values = { [ruleSubject(meaning)]: 0.9, [ruleSubject(asked)]: 0.9 };
    const r = await h.matcher.rejudge(rerunMessages(db, req), rerunSubjects(db, req.queryId));
    expect(r).toMatchObject({ asked: 2, failed: 0 });
    expect(h.jev.requests.flatMap((q) => Object.keys(q.questions)).every((k) => k.startsWith(`${ruleSubject(meaning)}_`))).toBe(true);
    expect(h.probe.runs.map((run) => run.rule.id)).toEqual([meaning, meaning]);
    expect(h.probe.runs.every((run) => run.history)).toBe(true);
  });

  it('refuses a query that is not per-message', () => {
    expect(() => rerunSubjects(db, 'channels.suggest')).toThrow(/per-message/);
    expect(() => rerunSubjects(db, NOTABLE_QUERY)).not.toThrow();
  });
});
