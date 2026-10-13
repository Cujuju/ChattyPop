import type { JSX } from 'solid-js';
import { contained, type FailureShown } from '@/ui/contained';
import type { LooseContributions, SlotContributions } from './define';
import type { ReadContributions } from './readSlots';
import type { FilterView, KindView } from '@/views/settings/rules/kinds/types';
import type { RuleSection } from '@shared/ruleKinds/types';

type FieldPolicy = Exclude<FailureShown, 'reload'> | 'keep';
type KeysOfUnion<V> = V extends unknown ? keyof V : never;
/** Every field needs a stated policy, including fields specific to a union member. */
type FieldPolicies<V> = { readonly [F in KeysOfUnion<V>]-?: FieldPolicy };
type SingleKind = 'rules' | 'composer' | 'channels';
type ByIdKind = Exclude<keyof LooseContributions, SingleKind>;
type ViewOf<K extends ByIdKind> = NonNullable<LooseContributions[K]> extends Readonly<Record<string, infer V>> ? V : never;

const BY_ID: { readonly [K in ByIdKind]: FieldPolicies<ViewOf<K>> } = {
  panels: { view: 'note', unread: 'keep' },
  windows: { title: 'name', view: 'note' },
  settings: { body: 'note', meta: 'keep', muted: 'keep' },
  shortcuts: {},
  providers: { rows: 'note', note: 'keep', modelAction: 'nothing' },
  jevFeatures: { Body: 'note', group: 'keep', hint: 'keep', perMessage: 'keep' },
  statusBar: { Component: 'nothing' },
  topBar: { Component: 'nothing' },
  phoneSections: { label: 'keep', section: 'keep', Component: 'note', badge: 'keep', place: 'keep', overview: 'keep' },
  phoneDrawer: { label: 'keep', section: 'keep', Component: 'note', opensArchive: 'keep' },
  providerRows: { Component: 'note' },
  notificationKinds: { label: 'keep', desktop: 'keep' },
  unread: { count: 'keep', markSeen: 'keep', onShown: 'keep', kind: 'keep' },
  personSections: { Component: 'note' },
  personLinks: { Component: 'note' },
  personTabs: { label: 'keep', Component: 'note' },
  messageMenu: { calls: 'keep', heading: 'keep', menu: 'keep' },
  attachmentMenu: { calls: 'keep', item: 'keep' },
  selectionMenu: { calls: 'keep', item: 'keep' },
  chatFooter: { Component: 'note' },
  hoverEmoji: { Component: 'nothing' },
  hoverActions: { Component: 'nothing' },
  attachmentActions: { Component: 'nothing' },
  ruleTemplates: { title: 'keep', flow: 'keep', hint: 'keep', make: 'keep' },
};
const RULES: FieldPolicies<NonNullable<LooseContributions['rules']>> = {
  managedControls: 'keep', activity: 'keep', actsAsYouNote: 'note',
  // Called tracked by the host; failures reach that host view's boundary.
  ruleBadge: 'keep',
  triggers: 'keep', match: 'keep', filters: 'keep', actions: 'keep',
};
const KIND = {
  // Called tracked by the host; failures reach that host view's boundary.
  label: 'keep',
  managedOnly: 'keep', windowHint: 'keep', Editor: 'note', summary: 'keep',
} as const;
const RULE_KINDS: { readonly [S in RuleSection]: FieldPolicies<S extends 'filters' ? FilterView : KindView> } = {
  triggers: KIND, match: KIND, actions: KIND, filters: { ...KIND, chips: 'keep' },
};
const COMPOSER: FieldPolicies<NonNullable<SlotContributions['composer']>> = { commands: 'keep' };
const CHANNELS: FieldPolicies<NonNullable<ReadContributions['channels']>> = { calls: 'keep', jevItems: 'keep' };

type Fields = Record<string, unknown>;
type Policies = Readonly<Record<string, FieldPolicy>>;
const isFields = (value: unknown): value is Fields => value !== null && typeof value === 'object';

function guardFields(name: string, fields: Fields, policies: Policies): Fields {
  let copy: Fields | undefined;
  for (const [field, policy] of Object.entries(policies)) {
    const view = fields[field];
    if (policy === 'keep' || typeof view !== 'function') continue;
    copy ??= { ...fields };
    copy[field] = contained(name, view as (props: object) => JSX.Element, policy);
  }
  return copy ?? fields;
}

function guardById(name: string, values: unknown, policies: Policies): unknown {
  if (!isFields(values)) return values;
  let copy: Fields | undefined;
  for (const [id, value] of Object.entries(values)) {
    if (!isFields(value)) continue;
    const guarded = guardFields(name, value, policies);
    if (guarded === value) continue;
    copy ??= { ...values };
    copy[id] = guarded;
  }
  return copy ?? values;
}

function guardRules(name: string, rules: unknown): unknown {
  if (!isFields(rules)) return rules;
  let guarded = guardFields(name, rules, RULES);
  for (const [section, policies] of Object.entries(RULE_KINDS)) {
    const values = guardById(name, rules[section], policies);
    if (values === rules[section]) continue;
    if (guarded === rules) guarded = { ...rules };
    guarded[section] = values;
  }
  return guarded;
}

/** Copies changed view fields, preserving kept fields, nested objects and the plugin's own contributions. */
export function guardContributions<C extends object>(name: string, contributions: C): C {
  const fields = contributions as Fields;
  let copy: Fields | undefined;
  const replace = (kind: string, guarded: unknown): void => {
    if (guarded === fields[kind]) return;
    copy ??= { ...fields };
    copy[kind] = guarded;
  };
  for (const [kind, policies] of Object.entries(BY_ID)) replace(kind, guardById(name, fields[kind], policies));
  replace('rules', guardRules(name, fields.rules));
  for (const [kind, policies] of Object.entries({ composer: COMPOSER, channels: CHANNELS })) {
    const value = fields[kind];
    if (isFields(value)) replace(kind, guardFields(name, value, policies));
  }
  return (copy ?? contributions) as C;
}
