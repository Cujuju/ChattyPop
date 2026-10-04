// Rule version upgrades, stored-spec migration and legacy activity labels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AFTER_MESSAGE } from '@plugin-sdk/shared';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { upgradeRuleSpec, upgradeV3 } from '@shared/ruleUpgrade';
import { actionInfo } from '@shared/rules';
import { MS_PER_HOUR } from '@shared/units';
import { migrateRuleSpecs } from '../src/core/laterMigrations';
import { tempDb } from './helpers';

const v3 = (patch: Record<string, unknown> = {}) => ({
  v: 3,
  trigger: { kind: 'message' },
  gates: { edits: true, missed: true },
  match: {},
  narrow: {},
  actions: [],
  ...patch,
});
/** Plugins declaring the action types old recorded runs name, as builds with those plugins would. */
const owners: PluginDescriptor[] = ['alerts.notify', 'tags.apply', 'summaries.summarize'].map((type) => {
  const id = type.split('.')[0]!;
  return {
    manifest: { id, name: id, version: '1', description: '' },
    rules: { actions: [{ ...AFTER_MESSAGE, type, label: `${type} label`, hint: `${type} hint`, create: () => null, validate() {} }] },
  };
});
beforeAll(() => void (BUNDLED_PLUGINS as PluginDescriptor[]).push(...owners));
afterAll(() => {
  const list = BUNDLED_PLUGINS as PluginDescriptor[];
  for (const o of owners) list.splice(list.indexOf(o), 1);
});
const question = { type: 'noul', question: 'Selling?', yes: '', no: '', minProbability: 0.5 };
describe('v3 to v4', () => {
  it.each([
    [{ kind: 'message' }, { type: 'message', config: null }],
    [
      { kind: 'daily', at: '08:00', days: [1] },
      { type: 'timed', config: { kind: 'daily', at: '08:00', days: [1] } },
    ],
    [
      { kind: 'every', hours: 6 },
      { type: 'timed', config: { kind: 'every', hours: 6 } },
    ],
    [
      { kind: 'appStart', awayHours: 8 },
      { type: 'timed', config: { kind: 'appStart', awayHours: 8 } },
    ],
    [
      { kind: 'tagApplied', tagIds: [7], sources: ['manual', 'jev'] },
      { type: 'tags.applied', config: { tagIds: [7], sources: ['manual', 'jev'] } },
    ],
  ])('keeps trigger %j', (trigger, expected) => expect(upgradeV3(v3({ trigger })).trigger).toEqual(expected));

  it.each([
    ['text', { pattern: 'sale', spec: null }],
    ['meaning', 'sales'],
    ['jev', question],
  ])('keeps the %s match', (type, config) =>
    expect(upgradeV3(v3({ match: { [String(type)]: config } })).match).toEqual([{ type, config }]),
  );

  it('keeps only the question when both Jev and meaning were stored', () => {
    expect(
      upgradeV3(v3({ match: { text: { pattern: 'sale', spec: null }, meaning: 'sales', jev: question } })).match,
    ).toEqual([
      { type: 'text', config: { pattern: 'sale', spec: null } },
      { type: 'jev', config: question },
    ]);
  });
  it.each<[string, string]>([
    ['aimed_at_me', 'alerts.aimed'],
    ['open_questions', 'alerts.openQuestion'],
  ])('materializes %s', (builtin, type) => {
    expect(upgradeV3(v3(), builtin).match).toEqual([{ type, config: null }]);
  });
  it('keeps every narrowing and gate', () => {
    const source = v3({
      narrow: { contains: ['voice'], linkPlatforms: ['youtube'], linkDomains: ['example.com'], tagIds: [7] },
    });
    const result = upgradeV3(source);
    expect(result.gates).toEqual(source.gates);
    expect(result.narrow).toEqual([
      { type: 'contains', config: ['voice'] },
      { type: 'linkPlatforms', config: ['youtube'] },
      { type: 'linkDomains', config: ['example.com'] },
      { type: 'tags.any', config: { tagIds: [7] } },
    ]);
  });
  it.each([
    ['notify', 'alerts.notify', { toast: { cooldownMs: 0 } }],
    ['tag', 'tags.apply', { tagId: 7 }],
    [
      'summarize',
      'summaries.summarize',
      { lookbackMs: MS_PER_HOUR, prompts: { summarize: 'Use {refs}', merge: null } },
    ],
    ['file', 'file', { path: 'C:/notes.md', format: 'markdown' }],
    ['plugin', 'command', { pluginId: 'folder', commandId: 'run', lookbackMs: MS_PER_HOUR }],
  ])('keeps %s configuration and action identity', (kind, type, config) => {
    expect(upgradeV3(v3({ actions: [{ id: 'same', kind, ...(config as object) }] })).actions).toEqual([
      { id: 'same', type, config },
    ]);
  });
  it('keeps an unavailable plugin action without validating it during upgrade', () => {
    expect(
      upgradeV3(v3({ actions: [{ id: 'p', kind: 'pluginAction', type: 'missing.run', config: { own: 1 } }] })).actions,
    ).toEqual([{ id: 'p', type: 'missing.run', config: { own: 1 } }]);
  });
  it.each([
    ['notify', 'alerts.notify'],
    ['tag', 'tags.apply'],
    ['summarize', 'summaries.summarize'],
    ['plugin', 'command'],
  ])('displays old recorded %s runs', (old, current) => {
    expect(actionInfo(old)).toEqual(actionInfo(current));
    expect(actionInfo(old).label).not.toMatch(/^Plugin action/);
  });
  it('rewrites every stored spec, including disabled and unavailable-plugin rules, idempotently', () => {
    const db = tempDb();
    const sources = [v3(), v3({ actions: [{ id: 'p', kind: 'pluginAction', type: 'missing.run', config: {} }] })];
    const insert = db.prepare(
      'INSERT INTO rules (name, spec, enabled, position, armed_at, created_at, builtin) VALUES (?, ?, ?, ?, 1, 1, ?)',
    );
    sources.forEach((s, i) => insert.run(`R${i}`, JSON.stringify(s), i, i, i === 0 ? 'aimed_at_me' : null));
    migrateRuleSpecs(db);
    const stored = db.prepare('SELECT spec FROM rules ORDER BY position').pluck().all() as string[];
    expect(stored.map((s) => JSON.parse(s))).toEqual(
      sources.map((s, i) => upgradeRuleSpec(JSON.stringify(s), i === 0 ? 'aimed_at_me' : null)),
    );
    expect(db.prepare("SELECT json_extract(spec, '$.v') AS v FROM rules").all()).toEqual([{ v: 4 }, { v: 4 }]);
    migrateRuleSpecs(db);
    expect(db.prepare('SELECT spec FROM rules ORDER BY position').pluck().all()).toEqual(stored);
  });
});
