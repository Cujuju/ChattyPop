// Rule kind validation, dispatch, lifecycle and ordering contracts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ruleKind, type RuleActionKind } from '@shared/ruleKinds';
import { jev } from '@shared/ruleKinds/host';
import { newRuleAction, newRuleInput, validateRuleSpec } from '@shared/ruleSpec';
import type { RuleSpec } from '@shared/rules';
import { MS_PER_DAY, MS_PER_HOUR } from '@shared/units';
import { RuleKinds } from '../src/core/rules/kinds';
import { AIMED, APPLIED, LEGACY_AIMED, includeR2Kinds } from './r2RuleKinds';

const file = () => ({ ...newRuleAction('file'), config: { path: 'C:/notes.md', format: 'markdown' } });
const command = () => ({
  ...newRuleAction('command'),
  config: { pluginId: 'p', commandId: 'c', lookbackMs: MS_PER_HOUR },
});
/** A new rule writing to a file: a valid spec for each case to break. */
const spec = (patch: Partial<RuleSpec> = {}): RuleSpec => ({ ...newRuleInput().spec, actions: [file()], ...patch });
const done = { outcome: 'done' as const, detail: null };
const restore: (() => void)[] = [];
let removeKinds: () => void;
beforeAll(() => void (removeKinds = includeR2Kinds()));
afterAll(() => removeKinds());
function flags(type: string, patch: Partial<RuleActionKind>): void {
  const kind = ruleKind('actions', type)!;
  const before = { ...kind };
  Object.assign(kind, patch);
  restore.push(() => Object.assign(kind, before));
}
afterEach(() => {
  restore.splice(0).forEach((f) => f());
});

describe('rule kind cross-part validation', () => {
  it('rejects repeated match/filter types and action ids', () => {
    const text = { type: 'text', config: { pattern: 'x', spec: null } };
    expect(() => validateRuleSpec(spec({ match: [text, text] }), false)).toThrow(/only once/);
    const filter = { type: 'contains', config: ['voice'] };
    expect(() => validateRuleSpec(spec({ narrow: [filter, filter] }), false)).toThrow(/only once/);
    const a = file();
    expect(() => validateRuleSpec(spec({ actions: [a, a] }), false)).toThrow(/could not be read/);
  });
  it('permits at most one Jev match, only on arrivals', () => {
    const meaning = { type: 'meaning', config: 'sales' };
    expect(() =>
      validateRuleSpec(spec({ match: [meaning, { type: 'jev', config: { ...jev.create(), question: 'Urgent?' } }] }), false),
    ).toThrow(/at most one/);
    expect(() =>
      validateRuleSpec(spec({ trigger: { type: APPLIED, config: { ids: [1] } }, match: [meaning] }), false),
    ).toThrow(/new messages/);
  });
  it('checks event targets and window restrictions from declarations', () => {
    const timed = { type: 'timed', config: { kind: 'every', hours: 1 } };
    // The command is the only declared action that acts on a window.
    expect(() => validateRuleSpec(spec({ trigger: timed }), false)).toThrow(
      'A rule that runs on a schedule can only run a plugin command.',
    );
    const window = spec({ trigger: timed, actions: [command()] });
    expect(() => validateRuleSpec(window, false)).not.toThrow();
    expect(() => validateRuleSpec({ ...window, narrow: [{ type: 'contains', config: ['voice'] }] }, false)).toThrow(
      /clear what it matches/,
    );
    expect(() =>
      validateRuleSpec({ ...window, gates: { ...window.gates, authorIds: ['123456789012345678'] } }, false),
    ).toThrow(/covers everyone/);
    flags('file', { targets: ['window'] });
    expect(() => validateRuleSpec(spec({ actions: [file()] }), false)).toThrow(/cannot act on a message/);
  });
  it('checks posting permission, managed matches and missing kinds', () => {
    expect(() => validateRuleSpec(spec(), false, LEGACY_AIMED)).toThrow();
    expect(() => validateRuleSpec(spec({ match: [{ type: AIMED, config: null }] }), false, LEGACY_AIMED)).not.toThrow();
    flags('file', { actsAsYou: true });
    expect(() => validateRuleSpec(spec({ actions: [file()] }), false)).toThrow(/Post to Discord as you/);
    expect(() => validateRuleSpec(spec({ actions: [file()] }), true)).not.toThrow();
  });

  it("reports unknown host types as malformed, and keeps an absent plugin's parts for ruleUnavailable to explain", () => {
    expect(() => validateRuleSpec(spec({ narrow: [{ type: 'unknown', config: null }] }), false)).toThrow(
      'The rule could not be read.',
    );
    expect(() => validateRuleSpec(spec({ narrow: [{ type: 'absent.filter', config: null }] }), false)).not.toThrow();
  });
  it('rejects an unsupported floor when the action is registered', () => {
    flags('file', { minIntervalMs: MS_PER_DAY });
    expect(() => new RuleKinds().action('file', () => done)).toThrow('Unsupported rule action interval');
  });
});
