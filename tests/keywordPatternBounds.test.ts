// Keyword patterns finish on any text: highlighting skips empty matches by code point, and builder wildcards can't backtrack combinatorially.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { EMPTY_PATTERN_SPEC, buildPattern, compileKeywordPattern, type PatternSpec } from '@shared/keywordPattern';

/** Far beyond a bounded run (milliseconds) plus worker start-up on a busy runner; the faults this guards never finish. */
const DEADLINE_MS = 5_000;
/** A message at Discord's ordinary length limit. */
const MESSAGE_CHARS = 2000;
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/shared/keywordPattern.ts')).href;

/** Evaluates `expr` (with the real module as `k`) in a worker, so a hang fails the test instead of freezing the runner. */
function bounded(expr: string, label = expr): Promise<unknown> {
  const w = new Worker(
    `const { parentPort } = require('node:worker_threads');
     import(${JSON.stringify(MODULE)}).then((k) => parentPort.postMessage(${expr}));`,
    { eval: true },
  );
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      void w.terminate();
      fail(new Error(`still running after ${DEADLINE_MS} ms: ${label}`));
    }, DEADLINE_MS);
    w.once('message', (v: unknown) => {
      clearTimeout(timer);
      void w.terminate();
      done(v);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
  });
}

const spec = (p: Partial<PatternSpec>): PatternSpec => ({ ...EMPTY_PATTERN_SPEC, ...p });
/** `test` of the builder's pattern for `p` over `text`, in a worker. */
const builderTest = (p: Partial<PatternSpec>, text: string): Promise<unknown> =>
  bounded(`k.compileKeywordPattern(k.buildPattern(${JSON.stringify(spec(p))})).test(${JSON.stringify(text)})`, `builder ${JSON.stringify(p)}`);

describe('highlight ranges', () => {
  it('skip empty matches by whole code points', async () => {
    expect(await bounded(`k.matchRanges(/a*/u, '😀', 50)`)).toEqual([]);
    expect(await bounded(`k.matchRanges(/(?=)/u, '😀x😀', 50)`)).toEqual([]);
    expect(await bounded(`k.matchRanges(/x*/v, '😀x😀', 50)`)).toEqual([[2, 3]]);
    expect(await bounded(`k.matchRanges(/a*/u, 'a😀a', 50)`)).toEqual([[0, 1], [3, 4]]);
    expect(await bounded(`k.matchRanges(/a*/, 'a😀a', 50)`)).toEqual([[0, 1], [3, 4]]);
  });
});

describe('builder wildcards', () => {
  const noMatch = 'a'.repeat(MESSAGE_CHARS);

  it('finish on a long non-match however many wildcards a term has', async () => {
    for (const term of ['a*a*a*a*a*b', 'a**a**a**a**a**b', 'a*a?a*a*a*b*']) {
      expect(await builderTest({ anyOf: [term] }, noMatch)).toBe(false);
      expect(await builderTest({ anyOf: [term], wholeWords: false }, noMatch)).toBe(false);
      expect(await builderTest({ anyOf: ['x'], allOf: [term] }, `x ${noMatch}`)).toBe(false);
      expect(await builderTest({ anyOf: ['x'], noneOf: [term], wholeWords: false }, `x ${noMatch}`)).toBe(true);
    }
  });

  it('still match what the glob describes', () => {
    const test = (term: string, text: string, wholeWords = true): boolean =>
      compileKeywordPattern(buildPattern(spec({ anyOf: [term], wholeWords }))).test(text);
    expect(test('a*a*b', 'aaxab')).toBe(true);
    expect(test('a*a*b', 'axyzb')).toBe(false); // the second "a" is missing
    expect(test('a*b', 'abxb')).toBe(true); // the last segment ends the word
    expect(test('a*b*c', 'abbbcxc')).toBe(true);
    expect(test('a*-x*b', 'aa-xxb')).toBe(true); // a segment with punctuation
    expect(test('a*x y*b', 'aax  yyb')).toBe(true); // a segment with a space
    expect(test('a*b', 'a b')).toBe(false); // a wildcard is letters and digits only
    expect(test('re*ck*', 'restocked')).toBe(true);
    expect(test('re*ck*', 'xrestocked')).toBe(false);
    expect(test('re*ck*', 'xrestocked', false)).toBe(true);
    expect(test('c?l*r', 'colour')).toBe(true);
  });
});
