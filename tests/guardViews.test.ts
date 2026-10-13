import { beforeAll, expect, it } from 'vitest';

type Fields = Record<string, unknown>;
let guard: <C extends object>(name: string, contributions: C) => C;
const fn = () => null;
const nested = { keep: fn };
const calls = ['probe'];

const policyFixture: Record<string, { fields: Fields; contained: string[] }> = {
  panels: { fields: { view: fn, unread: nested }, contained: ['view'] },
  windows: { fields: { title: fn, view: fn }, contained: ['title', 'view'] },
  settings: { fields: { body: fn, meta: fn, muted: fn }, contained: ['body'] },
  providers: { fields: { rows: fn, note: fn, modelAction: fn }, contained: ['rows', 'modelAction'] },
  jevFeatures: { fields: { Body: fn, group: 'probe', hint: fn, perMessage: nested }, contained: ['Body'] },
  statusBar: { fields: { Component: fn }, contained: ['Component'] },
  topBar: { fields: { Component: fn }, contained: ['Component'] },
  phoneSections: { fields: { label: fn, section: 'probe', Component: fn, badge: fn, place: nested, overview: [nested] }, contained: ['Component'] },
  phoneDrawer: { fields: { label: fn, section: 'probe', Component: fn, opensArchive: fn }, contained: ['Component'] },
  providerRows: { fields: { Component: fn }, contained: ['Component'] },
  notificationKinds: { fields: { label: fn, desktop: fn }, contained: [] },
  unread: { fields: { count: fn, markSeen: fn, onShown: fn, kind: 'probe' }, contained: [] },
  personSections: { fields: { Component: fn }, contained: ['Component'] },
  personLinks: { fields: { Component: fn }, contained: ['Component'] },
  personTabs: { fields: { label: 'probe', Component: fn }, contained: ['Component'] },
  messageMenu: { fields: { calls, heading: 'probe', menu: fn }, contained: [] },
  attachmentMenu: { fields: { calls, item: fn }, contained: [] },
  selectionMenu: { fields: { calls, item: fn }, contained: [] },
  chatFooter: { fields: { Component: fn }, contained: ['Component'] },
  hoverEmoji: { fields: { Component: fn }, contained: ['Component'] },
  hoverActions: { fields: { Component: fn }, contained: ['Component'] },
  attachmentActions: { fields: { Component: fn }, contained: ['Component'] },
  ruleTemplates: { fields: { title: 'probe', flow: fn, hint: fn, make: fn }, contained: [] },
};
const kind = { label: fn, managedOnly: true, windowHint: fn, Editor: fn, summary: fn };

beforeAll(async () => {
  const path = '../src/renderer/src/plugins/guardViews';
  ({ guardContributions: guard } = await import(path));
});

it('17: every contribution kind and rule section is guarded without changing kept fields or the input', () => {
  const byId = Object.fromEntries(Object.entries(policyFixture).map(([key, { fields }]) => [key, { probe: Object.freeze(fields) }]));
  const rules = {
    managedControls: nested, activity: fn, actsAsYouNote: fn, ruleBadge: fn,
    triggers: { probe: kind }, match: { probe: kind }, actions: { probe: kind }, filters: { probe: { ...kind, chips: fn } },
  };
  const input = Object.freeze({ ...byId, shortcuts: { probe: fn }, rules, composer: { commands: fn }, channels: { calls, jevItems: fn } });
  const guarded = guard('Probe', input) as Fields;
  const read = () => guarded;
  expect(guarded).not.toBe(input);
  expect(read()).toBe(read());
  for (const [key, { fields, contained }] of Object.entries(policyFixture)) {
    const values = guarded[key] as Record<string, Fields>;
    const value = values.probe!;
    expect(Object.keys(value)).toEqual(Object.keys(fields));
    expect(read()[key]).toBe(values);
    expect((input as Fields)[key]).toBe(byId[key]);
    if (contained.length) expect(values).not.toBe(byId[key]);
    else expect(values).toBe(byId[key]);
    for (const [field, original] of Object.entries(fields)) {
      if (contained.includes(field)) expect(value[field]).not.toBe(original);
      else expect(value[field]).toBe(original);
      expect((byId[key] as { probe: Fields }).probe[field]).toBe(original);
    }
  }
  expect(guarded.shortcuts).toBe(input.shortcuts);
  expect(input.shortcuts.probe).toBe(fn);
  expect(guarded.composer).toBe(input.composer);
  expect(guarded.channels).toBe(input.channels);
  const guardedRules = guarded.rules as typeof rules;
  expect(guardedRules).not.toBe(rules);
  expect(guardedRules.actsAsYouNote).not.toBe(fn);
  expect(rules.actsAsYouNote).toBe(fn);
  for (const field of ['managedControls', 'activity', 'ruleBadge'] as const) expect(guardedRules[field]).toBe(rules[field]);
  for (const section of ['triggers', 'match', 'actions', 'filters'] as const) {
    expect(guardedRules[section]).not.toBe(rules[section]);
    expect(guardedRules[section].probe.Editor).not.toBe(fn);
    expect(rules[section].probe.Editor).toBe(fn);
    for (const field of ['label', 'managedOnly', 'windowHint', 'summary'] as const) expect(guardedRules[section].probe[field]).toBe(kind[field]);
  }
  expect(guardedRules.filters.probe.chips).toBe(fn);
});

it('17: absent optional fields stay absent, nonfunctions stay identical and unchanged contributions need no copy', () => {
  const input = {
    settings: { probe: { body: fn } }, providers: { probe: {} }, panels: { probe: { view: fn } },
    rules: { triggers: { probe: { Editor: fn, label: 'Probe' } } },
  };
  const guarded = guard('Probe', input);
  expect(Object.keys(guarded.settings.probe)).toEqual(['body']);
  expect(Object.keys(guarded.panels.probe)).toEqual(['view']);
  expect(Object.keys(guarded.rules)).toEqual(['triggers']);
  expect(Object.keys(guarded.rules.triggers.probe)).toEqual(['Editor', 'label']);
  expect(guarded.providers).toBe(input.providers);
  const unchanged = { shortcuts: { probe: fn }, composer: { commands: fn }, channels: { calls, jevItems: fn }, rules: { ruleBadge: fn } };
  expect(guard('Probe', unchanged)).toBe(unchanged);
  const nonfunctions = { panels: { probe: { view: 'Already drawn', unread: nested } } };
  expect(guard('Probe', nonfunctions)).toBe(nonfunctions);
});
