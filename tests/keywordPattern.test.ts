import { describe, expect, it } from 'vitest';
import { EMPTY_PATTERN_SPEC, buildPattern, matchRanges, specProblem, type PatternSpec } from '@shared/keywordPattern';
import { compileKeywordPattern } from '@shared/keywordPattern';
import { previewPattern } from '../src/core/patternPreview';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage } from './helpers';
import { probeRule, ruleHarness } from './ruleHarness';

const spec = (p: Partial<PatternSpec>): PatternSpec => ({ ...EMPTY_PATTERN_SPEC, ...p });
const matcher = (p: Partial<PatternSpec>): RegExp => compileKeywordPattern(buildPattern(spec(p)));

describe('regex builder', () => {
  const gb = matcher({ anyOf: ['gb', 'group buy'], allOf: ['keyboard'], noneOf: ['sold out'] });

  it('needs any-of, all-of and none-of anywhere in the message, and marks the any-of term', () => {
    expect(gb.test('The keyboard group buy opens Friday')).toBe(true);
    expect(gb.test('GB opens friday for the new Keyboard')).toBe(true); // required word after the match, any case
    expect(gb.test('gb opens friday')).toBe(false); // no "keyboard"
    expect(gb.test('keyboard gb sold  out already')).toBe(false); // excluded, across extra spaces
    expect(gb.test('keyboard\ngb open')).toBe(true); // conditions span lines
    const text = 'keyboard gb and another group buy';
    expect(matchRanges(gb, text, 10).map(([s, e]) => text.slice(s, e))).toEqual(['gb', 'group buy']);
  });

  it('wildcards, whole words and case', () => {
    expect(matcher({ anyOf: ['restock*'] }).test('Restocked today')).toBe(true);
    expect(matcher({ anyOf: ['v?'] }).test('v2 is out')).toBe(true);
    expect(matcher({ anyOf: ['art'] }).test('start')).toBe(false);
    expect(matcher({ anyOf: ['art'], wholeWords: false }).test('start')).toBe(true);
    expect(matcher({ anyOf: ['Rust'], matchCase: true }).test('rust')).toBe(false);
    expect(matcher({ anyOf: ['c++', 'a/b'] }).test('learning C++ and a/b tests')).toBe(true);
  });

  it('rejects a rule that could only exclude, or a wildcard-only word', () => {
    expect(specProblem(spec({ noneOf: ['spam'] }))).toMatch(/at least one word/);
    expect(specProblem(spec({ anyOf: ['*'] }))).toMatch(/letter or digit/);
    expect(() => buildPattern(spec({}))).toThrow();
  });
});

describe('rules store the builder rule and the pattern built from it', () => {
  it('saves the rule, derives the pattern, and previews recent matches in scope', () => {
    const h = ruleHarness();
    const [deals, chat] = ['200000000000000001', '200000000000000002'];
    h.archive.upsertChannels('g1', [
      { id: deals, name: 'deals', type: 0 },
      { id: chat, name: 'chat', type: 0 },
    ]);
    [deals, chat].forEach((c) => h.archive.setOptIn(c, true));
    const now = Date.now();
    h.archive.ingestMessages(
      [
        rawMessage(deals, now - 3000, 'keyboard gb live now'),
        rawMessage(chat, now - 2000, 'keyboard gb in chat'),
        rawMessage(deals, now - 1000, 'keyboard gb sold out'),
      ],
      ARRIVAL.gateway,
    );
    const built = spec({ anyOf: ['gb'], allOf: ['keyboard'], noneOf: ['sold out'] });
    const id = h.rules.create(probeRule({ text: { pattern: buildPattern(built), spec: built } }));
    const text = h.rules
      .list()
      .find((r) => r.id === id)!
      .spec.match.find((p) => p.type === 'text')!.config as import('@shared/ruleKinds/host').TextConfig;
    expect(text.spec).toEqual(built);

    const all = previewPattern(h.db, text.pattern, null, null, now);
    expect(all.matched).toBe(2);
    expect(all.hits.map((x) => x.channelName)).toEqual(['chat', 'deals']); // newest first
    const inDeals = previewPattern(h.db, text.pattern, [deals], null, now);
    expect(inDeals.hits.map((x) => x.text)).toEqual(['keyboard gb live now']);
  });
});
