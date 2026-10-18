// The search builder's filters: every parser key is listed, and picks edit the query as the parser reads it.
import { expect, it, vi } from 'vitest';
import { HOST_SEARCH_KEYS } from '@shared/searchTokens';
import { parseSearchQuery } from '@shared/searchQuery';
import { joinQuery, pendingFilter, searchFilters, serverTerm, splitQuery, withChoice, withFilter, withValue, type FilterChoice } from '../src/renderer/src/frame/searchFilters';

const tag = { key: 'tag', description: 'Tagged', value: 'tag name' };

it('lists every host key and places plugin tokens with the content filters, before the dates', () => {
  const keys = searchFilters([tag]).map((f) => f.key);
  expect([...keys].sort()).toEqual([...HOST_SEARCH_KEYS, 'tag'].sort());
  expect(keys.indexOf('tag')).toBe(keys.indexOf('is') + 1);
});

it('finds the trailing key awaiting a value, negated or not, with the value typed so far', () => {
  const filters = searchFilters([tag]);
  expect(pendingFilter('cats has:', filters)).toMatchObject({ filter: { key: 'has' }, partial: '', negated: false });
  expect(pendingFilter('-TAG:', filters)).toMatchObject({ filter: { key: 'tag' }, negated: true });
  expect(pendingFilter('has:li', filters)).toMatchObject({ filter: { key: 'has' }, partial: 'li' });
  expect(pendingFilter('from:"Ada L', filters)).toMatchObject({ filter: { key: 'from' }, partial: 'Ada L' });
  expect(pendingFilter('has:link ', filters)).toBeUndefined();
  expect(pendingFilter('from:"Ada L" ', filters)).toBeUndefined();
  expect(pendingFilter('http:', filters)).toBeUndefined();
  expect(pendingFilter('cats', filters)).toBeUndefined();
});

it('replaces the value typed so far with the picked one', () => {
  expect(withValue('cats has:im', 'image')).toBe('cats has:image ');
  expect(withValue('from:"Ada', 'Ada L')).toBe('from:"Ada L" ');
});

it('adds a narrowing term to a picked value, but not to a negated one', () => {
  const filters = searchFilters([]);
  const choice = { label: 'general', value: 'general', narrow: serverTerm('Book Club') };
  expect(withChoice('in:gen', pendingFilter('in:gen', filters)!, choice)).toBe('in:general server:"Book Club" ');
  expect(withChoice('-in:gen', pendingFilter('-in:gen', filters)!, choice)).toBe('-in:general ');
  expect(parseSearchQuery('in:general server:"Book Club" ').terms).toEqual([
    { key: 'in', value: 'general', negated: false },
    { key: 'server', value: 'Book Club', negated: false },
  ]);
});

it('offers the named filters their sources and the short ones only values matching what is typed', async () => {
  const people = vi.fn(async (partial: string) => [{ label: partial, value: partial }]);
  const filters = searchFilters([], { people, channels: () => [], servers: () => [] });
  expect(await filters.find((f) => f.key === 'from')!.choices('ad')).toEqual([{ label: 'ad', value: 'ad' }]);
  expect(people).toHaveBeenCalledWith('ad');
  expect(filters.find((f) => f.key === 'has')!.choices('im')).toEqual([{ label: 'image', value: 'image' }]);
  expect(filters.filter((f) => f.named).map((f) => f.key)).toEqual(['from', 'in', 'server']);
});

it('builds queries the parser reads as the picked filters', () => {
  const query = withValue(withFilter(withValue(withFilter('cats ', 'has'), 'image'), 'from'), 'Ada L');
  expect(query).toBe('cats has:image from:"Ada L" ');
  expect(parseSearchQuery(query)).toMatchObject({ words: 'cats', problems: [], terms: [{ key: 'has', value: 'image' }, { key: 'from', value: 'Ada L' }] });
});

it('offers date choices the parser accepts', () => {
  const during = searchFilters([]).find((f) => f.key === 'during')!;
  for (const c of during.choices('') as FilterChoice[]) expect(parseSearchQuery(`during:${c.value}`).problems).toEqual([]);
});

it('shows each finished term as a chip and the rest as the draft, and joins them back to the same query', () => {
  const { chips, draft } = splitQuery('cats -from:theo in:"two words" has:nothing x tag:y', ['tag']);
  expect(chips).toEqual([
    { raw: '-from:theo', key: 'from', value: 'theo', negated: true, problem: false },
    { raw: 'in:"two words"', key: 'in', value: 'two words', negated: false, problem: false },
    { raw: 'has:nothing', key: 'has', value: 'nothing', negated: false, problem: true },
  ]);
  // The last term has no space after it yet: still being typed.
  expect(draft).toBe('cats x tag:y');
  expect(splitQuery('from:theo ', [])).toEqual({ chips: [expect.objectContaining({ key: 'from' })], draft: '' });
  expect(splitQuery('note:x from:"Ada L', []).chips).toEqual([]);
  for (const text of ['', 'cats', 'from:theo ', 'from:theo has:link cats from:', 'in:general  two  spaces']) {
    const split = splitQuery(text, []);
    expect(splitQuery(joinQuery(split.chips, split.draft), [])).toEqual(split);
  }
  expect(joinQuery(chips.slice(1), draft)).toBe('in:"two words" has:nothing cats x tag:y');
});
