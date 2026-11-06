import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import nspell from 'nspell';
import { describe, expect, it } from 'vitest';
import { rankSuggestions, spellingWords, SUGGESTION_MAX } from '@shared/spelling';

describe('draft spelling words', () => {
  it.each([
    ':picked_emoji:', '<:name:123>', '<a:name:123>', '<@123>', '<@!123>', '<@&123>', '<#123>', '<t:123:R>',
    'https://example.com/misspelled', 'www.example.com/misspelled', '`misspelled code`', '```ts\nmisspelled code\n```',
    'word123', '123word', 'under_score',
  ])('skips %s', (skipped) => {
    const text = `before ${skipped} after`;
    expect(spellingWords(text)).toEqual([
      { start: 0, end: 6, word: 'before' },
      { start: text.length - 5, end: text.length, word: 'after' },
    ]);
  });

  it('keeps letters and inner apostrophes with UTF-16 offsets', () => {
    const text = "😀 don't, it’s 'fine' café";
    expect(spellingWords(text)).toEqual(["don't", 'it’s', 'fine', 'café'].map((word) => ({
      start: text.indexOf(word), end: text.indexOf(word) + word.length, word,
    })));
  });
});

describe('suggestion ranking', () => {
  it('puts adjacent swaps first case-insensitively, preserving order and capping results', () => {
    const suggestions = ['ten', 'tea', 'THE', 'eth', 'tech', 'te', 'tee'];
    expect(rankSuggestions('teh', suggestions)).toEqual(['THE', 'eth', 'ten', 'tea', 'tech']);
    expect(rankSuggestions('teh', suggestions)).toHaveLength(SUGGESTION_MAX);
    expect(suggestions[0]).toBe('ten');
  });

  const dictionaryDir = dirname(createRequire(import.meta.url).resolve('dictionary-en'));
  const checker = nspell({
    aff: readFileSync(join(dictionaryDir, 'index.aff'), 'utf8'),
    dic: readFileSync(join(dictionaryDir, 'index.dic'), 'utf8'),
  });
  it.each([['dogg', 'dog'], ['teh', 'the'], ['untill', 'until'], ['catt', 'cat']])('ranks %s → %s first with the bundled dictionary', (word, expected) => {
    expect(rankSuggestions(word, checker.suggest(word))[0]).toBe(expected);
  });
  it('recognizes dog', () => {
    expect(checker.correct('dog')).toBe(true);
  });
});
