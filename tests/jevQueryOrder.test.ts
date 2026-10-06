// Plugin query anchors use the complete folder catalog, preserving placement among host queries across build selections.
import { describe, expect, it } from 'vitest';
import { definePlugin, type JevQueryDecl } from '@plugin-sdk/shared';
import { anchorCatalog, catalogJevQueryAnchor, checkBundled } from '@shared/bundledCheck';
import { JEV_QUERIES, orderJevQueries, type JevQueryDef } from '@shared/jevQueries';
import { HOST_JEV_QUERIES } from '@shared/jevQueries/host';

const query = (id: string, placement: Partial<Record<'after' | 'before', string>> = {}, group: JevQueryDecl['group'] = 'Messages'): JevQueryDecl<'on'> =>
  ({
    id,
    group,
    label: id,
    features: ['on'],
    sees: '',
    use: 'display',
    condition: null,
    defaults: { type: 'noul', question: 'q', yes: '', no: '', minProbability: 0.5 },
    ...placement,
  }) as JevQueryDecl<'on'>;
const plugin = (id: string, ...queries: JevQueryDecl<'on'>[]) =>
  definePlugin({ manifest: { id, name: id, version: '1', description: '' }, jev: { features: [{ key: 'on', default: false }], queries } });

/** Two plugins' queries, anchored on host queries, on each other and on the other plugin's. */
const FIXTURES = [
  plugin('r2a', query('r2a.aimed', { after: 'rules.meaning' }, 'Alerts'), query('r2a.question', { after: 'r2a.aimed' }, 'Alerts'), query('r2a.plans', { after: 'messages.tags' })),
  plugin('r2b', query('r2b.note', { after: 'r2a.plans' }), query('r2b.worth', { before: 'channels.suggest' }, 'Links & search'), query('r2b.rerank', { after: 'r2b.worth' }, 'Links & search')),
];
const queriesOf = (list: readonly (typeof FIXTURES)[number][]): JevQueryDef[] => list.flatMap((p) => p.jev.queries as unknown as JevQueryDef[]);
const anchorOf = catalogJevQueryAnchor(anchorCatalog(FIXTURES));
const PLACED = [
  'rules.meaning', 'r2a.aimed', 'r2a.question',
  'messages.notable', 'messages.classPolitical', 'messages.classFinance', 'messages.classTrading', 'messages.tags', 'r2a.plans', 'r2b.note',
  'r2b.worth', 'r2b.rerank', 'channels.suggest',
  'check.trolling', 'check.manipulation', 'check.coordination', 'check.humor', 'check.context',
];
const hostIds = new Set(HOST_JEV_QUERIES.map((q) => q.id));

describe('Settings → Jev → Queries order', () => {
  it("places plugins' queries by their anchors among the host's, and a build without plugins lists the host's alone", () => {
    expect(() => checkBundled(FIXTURES)).not.toThrow();
    expect(orderJevQueries(HOST_JEV_QUERIES, queriesOf(FIXTURES), anchorOf).map((q) => q.id)).toEqual(PLACED);
    expect(JEV_QUERIES.map((q) => q.id)).toEqual(PLACED.filter((id) => hostIds.has(id)));
  });

  it('keeps plugins’ queries where they were when the host adds a query at the end of a group they share', () => {
    const groupOf = new Map([...HOST_JEV_QUERIES, ...queriesOf(FIXTURES)].map((q) => [q.id, q.group]));
    for (const group of new Set(HOST_JEV_QUERIES.map((q) => q.group))) {
      const added = { ...HOST_JEV_QUERIES.find((q) => q.group === group)!, id: 'host.added' };
      const last = PLACED.findLastIndex((id) => groupOf.get(id) === group);
      const expected = [...PLACED.slice(0, last + 1), added.id, ...PLACED.slice(last + 1)];
      expect(orderJevQueries([...HOST_JEV_QUERIES, added], queriesOf(FIXTURES), anchorOf).map((q) => q.id), group).toEqual(expected);
    }
  });

  it('keeps that relative order in a build that leaves a plugin out, its anchors read from the catalog', () => {
    for (const left of FIXTURES) {
      const kept = queriesOf(FIXTURES.filter((p) => p !== left));
      const ids = new Set([...HOST_JEV_QUERIES, ...kept].map((q) => q.id));
      expect(orderJevQueries(HOST_JEV_QUERIES, kept, anchorOf).map((q) => q.id), `without ${left.manifest.id}`).toEqual(PLACED.filter((id) => ids.has(id)));
    }
  });
});

describe('checkBundled over Jev query placement', () => {
  const probe = (...queries: JevQueryDecl<'on'>[]) => plugin('qprobe', ...queries);
  /** Another plugin's query in Links & search, to anchor on. */
  const links = plugin('r2links', query('r2links.worth', {}, 'Links & search'));

  it("accepts an anchor on a host query or another plugin's, in either direction", () => {
    expect(() => checkBundled([links, probe(query('qprobe.a', { after: 'messages.tags' }), query('qprobe.b', { before: 'r2links.worth' }, 'Links & search'))])).not.toThrow();
  });

  it('refuses an anchor no query provides, a loop, both directions, and a host query id', () => {
    expect(() => checkBundled([probe(query('qprobe.a', { after: 'nowhere' }))])).toThrow(/Jev query qprobe\.a follows nowhere, which no plugin provides/);
    expect(() => checkBundled([probe(query('qprobe.a', { after: 'qprobe.b' }), query('qprobe.b', { before: 'qprobe.a' }))])).toThrow(/Jev query qprobe\.a: its placement loops/);
    expect(() => checkBundled([probe(query('qprobe.a', { after: 'messages.tags', before: 'messages.notable' }))])).toThrow(/Jev query qprobe\.a: one of after or before/);
    expect(() => checkBundled([probe(query('channels.suggest'))])).toThrow(/Jev query channels\.suggest/);
  });

  it('refuses an anchor in another group, host or plugin, which Settings could never place it by', () => {
    expect(() => checkBundled([probe(query('qprobe.a', { before: 'channels.suggest' }))])).toThrow(/qprobe\.a \(Messages\) is placed by channels\.suggest, in Links & search/);
    expect(() => checkBundled([links, probe(query('qprobe.a', { after: 'r2links.worth' }))])).toThrow(/placed by r2links\.worth, in Links & search/);
    // Anchored through a chain: each link is checked, so none reaches another group's query.
    const chained = probe(query('qprobe.a', { after: 'qprobe.b' }), query('qprobe.b', { after: 'r2links.worth' }));
    expect(() => checkBundled([chained], anchorCatalog([links, chained]))).toThrow(/qprobe\.b \(Messages\)/);
  });

  it('refuses a group Settings has no place for, which would leave the query unlisted and unaskable', () => {
    expect(() => checkBundled([probe(query('qprobe.a', {}, 'Messages & search' as never))])).toThrow(/qprobe\.a: no group Messages & search/);
  });

  it('refuses an id that is not <area>.<name>, so none can hide from the catalog or the stored edits', () => {
    for (const id of ['__proto__', 'constructor', 'qprobe', 'qprobe.a.b']) expect(() => checkBundled([probe(query(id))]), id).toThrow(/its id must match/);
  });

  it('keeps every declared item in the catalog, whatever its id', () => {
    const probe = { manifest: { id: 'qprobe', name: 'q', version: '1', description: '' }, panels: [{ id: '__proto__', after: 'nowhere' }] } as never;
    const catalog = anchorCatalog([probe]);
    expect(Object.keys(catalog.panels)).toEqual(['__proto__']);
    expect(() => checkBundled([probe], catalog)).toThrow(/Panel __proto__ follows nowhere/);
  });
});
