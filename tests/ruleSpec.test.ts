import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULE_SPEC_VERSION, runsOnMissed, type RuleInput, type RuleSpec } from '@shared/rules';
import { newRuleAction, newRuleInput, parseRuleSpec, validateRuleInput } from '@shared/ruleSpec';
import { AIMED, APPLIED, APPLY, LEGACY_AIMED, POST, includeR2Kinds } from './r2RuleKinds';

const file = () => ({ ...newRuleAction('file', 'f'), config: { path: 'C:/notes.md', format: 'markdown' } });
/** A new rule writing to a file, with `over` replacing its parts. */
const input = (over: Partial<RuleSpec> = {}, discordSend = false): RuleInput => {
  const base = newRuleInput();
  return { ...base, name: 'R', discordSend, spec: { ...base.spec, actions: [file()], ...over } };
};
let removeKinds: () => void;
beforeAll(() => void (removeKinds = includeR2Kinds()));
afterAll(() => removeKinds());

describe('rule spec', () => {
  it('reads back a stored current-version spec', () => {
    const spec = input().spec;
    expect(parseRuleSpec(JSON.stringify(spec))).toEqual(spec);
  });

  it('refuses a spec saved by a newer version, or unreadable, with a reason', () => {
    expect(() => parseRuleSpec(JSON.stringify({ ...input().spec, v: RULE_SPEC_VERSION + 1 }))).toThrow(
      /newer ChattyPop/,
    );
    expect(() => parseRuleSpec('{nope')).toThrow(/could not be read/);
    expect(() => parseRuleSpec(JSON.stringify({ trigger: { kind: 'message' } }))).toThrow(/could not be read/);
  });

  it("rejects a rule without actions, a bad pattern, a plugin trigger or action its kind rejects, or a bad person", () => {
    expect(() => validateRuleInput(input({ actions: [] }))).toThrow(/at least one action/);
    expect(() =>
      validateRuleInput(input({ match: [{ type: 'text', config: { pattern: '/(/', spec: null } }] })),
    ).toThrow();
    expect(() => validateRuleInput(input({ match: [{ type: 'meaning', config: ' ' }] }))).toThrow(/by meaning/);
    expect(() =>
      validateRuleInput(input({ trigger: { type: APPLIED, config: { ids: [] } } })),
    ).toThrow(/Pick the ids/);
    expect(() => validateRuleInput(input({ actions: [newRuleAction(APPLY)] }))).toThrow(/id to apply/);
    expect(() =>
      validateRuleInput(
        input({
          actions: [{ ...newRuleAction('file'), config: { path: 'relative.md', format: 'markdown' } } as never],
        }),
      ),
    ).toThrow(/file/);
    expect(() => validateRuleInput(input({ gates: { ...input().spec.gates, authorIds: ['@someone'] } }))).toThrow(
      /person/,
    );
    expect(() =>
      validateRuleInput(input({ gates: { ...input().spec.gates, authorIds: ['123456789012345678'] } })),
    ).not.toThrow();
  });

  it('matching by meaning needs the message trigger; a built-in rule keeps its match and narrowing empty', () => {
    expect(() =>
      validateRuleInput(
        input({
          trigger: { type: APPLIED, config: { ids: [1] } },
          match: [{ type: 'meaning', config: 'cats' }],
        }),
      ),
    ).toThrow(/new messages/);
    expect(() =>
      validateRuleInput(input({ match: [{ type: AIMED, config: null }] }), LEGACY_AIMED),
    ).not.toThrow();
    expect(() =>
      validateRuleInput(input({ narrow: [{ type: 'contains', config: ['link'] }] }), LEGACY_AIMED),
    ).toThrow();
  });

  it('a Discord post needs the rule opt-in and never acts on missed messages', () => {
    const post = newRuleAction(POST);
    expect(() => validateRuleInput(input({ actions: [post] }))).toThrow(/Post to Discord as you/);
    expect(() => validateRuleInput(input({ actions: [post] }, true))).not.toThrow();
    expect(runsOnMissed(post)).toBe(false);
    expect(runsOnMissed(file())).toBe(true);
  });

  it('upgrades a v1 spec: conditions split into gates, match and narrowing; backfill flags become the missed gate', () => {
    const v1 = {
      v: 1,
      trigger: { kind: 'message', edits: true },
      conditions: {
        channelIds: ['c1'],
        authorIds: ['123456789012345678'],
        text: { pattern: 'cjj', spec: null },
        contains: ['link'],
        tagIds: [3],
      },
      actions: [
        { id: 'a', kind: 'notify', backfill: true, toast: { cooldownMs: 5, backfill: false } },
        { id: 'b', kind: 'tag', tagId: 3, backfill: false },
      ],
    };
    expect(parseRuleSpec(JSON.stringify(v1))).toEqual({
      v: RULE_SPEC_VERSION,
      trigger: { type: 'message', config: null },
      gates: { channelIds: ['c1'], authorIds: ['123456789012345678'], edits: true, missed: true },
      match: [{ type: 'text', config: { pattern: 'cjj', spec: null } }],
      narrow: [
        { type: 'contains', config: ['link'] },
        { type: 'tags.any', config: { tagIds: [3] } },
      ],
      actions: [
        { id: 'a', type: 'alerts.notify', config: { toast: { cooldownMs: 5 } } },
        { id: 'b', type: 'tags.apply', config: { tagId: 3 } },
      ],
    });
    const quiet = {
      ...v1,
      trigger: { kind: 'tagApplied', tagIds: [3], sources: ['jev'] },
      actions: [{ ...v1.actions[1], backfill: false }],
    };
    expect(parseRuleSpec(JSON.stringify(quiet)).gates).toEqual({
      channelIds: ['c1'],
      authorIds: ['123456789012345678'],
      edits: false,
      missed: false,
    });
  });
});
