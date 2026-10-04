// The search builder's filters: every parser key is listed, and picks edit the query as the parser reads it.
import { expect, it } from 'vitest';
import { HOST_SEARCH_KEYS } from '@shared/searchTokens';
import { parseSearchQuery } from '@shared/searchQuery';
import { pendingFilter, searchFilters, withFilter, withValue } from '../src/renderer/src/frame/searchFilters';

const tag = { key: 'tag', description: 'Tagged', value: 'tag name' };

it('lists every host key and places plugin tokens with the content filters, before the dates', () => {
  const keys = searchFilters([tag]).map((f) => f.key);
  expect([...keys].sort()).toEqual([...HOST_SEARCH_KEYS, 'tag'].sort());
  expect(keys.indexOf('tag')).toBe(keys.indexOf('is') + 1);
});

it('finds the trailing key awaiting a value, negated or not', () => {
  const filters = searchFilters([tag]);
  expect(pendingFilter('cats has:', filters)?.key).toBe('has');
  expect(pendingFilter('-TAG:', filters)?.key).toBe('tag');
  expect(pendingFilter('has:link', filters)).toBeUndefined();
  expect(pendingFilter('http:', filters)).toBeUndefined();
  expect(pendingFilter('cats', filters)).toBeUndefined();
});

it('builds queries the parser reads as the picked filters', () => {
  const query = withValue(withFilter(withValue(withFilter('cats ', 'has'), 'image'), 'from'), 'Ada L');
  expect(query).toBe('cats has:image from:"Ada L" ');
  expect(parseSearchQuery(query)).toMatchObject({ words: 'cats', problems: [], terms: [{ key: 'has', value: 'image' }, { key: 'from', value: 'Ada L' }] });
});

it('offers date choices the parser accepts', () => {
  const during = searchFilters([]).find((f) => f.key === 'during')!;
  for (const c of during.choices()) expect(parseSearchQuery(`during:${c.value}`).problems).toEqual([]);
});
