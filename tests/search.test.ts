// Search syntax and archive filtering.
import { beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_MATCH_END, SEARCH_MATCH_START } from '@shared/contract';
import { normalizeSavedSearches, normalizeSearchSort, parsePeriod, parseSearchQuery, searchQuerySpans, type SearchSort } from '@shared/searchQuery';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { storeLinkText } from '../src/core/derivedText';
import { refreshLinkSearch } from '../src/core/linkSearch';
import { parseSearch, searchMessages } from '../src/core/queries/search';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

/** Noon local time on a day of September 2026 (month index 8), clear of any day edge. */
const sept = (day: number): number => new Date(2026, 8, day, 12).getTime();

describe('search query syntax', () => {
  it('separates words from operators', () => {
    const q = parseSearchQuery('madden from:theo in:#general has:image after:2026-09-01');
    expect(q.words).toBe('madden');
    expect(q.terms.map((t) => t.key)).toEqual(['from', 'in', 'has', 'after']);
    expect(q.problems).toEqual([]);
  });

  it('accepts quoted values and negation', () => {
    const q = parseSearchQuery('-from:"Billie Hwang" -has:link');
    expect(q.terms).toEqual([
      { key: 'from', value: 'Billie Hwang', negated: true },
      { key: 'has', value: 'link', negated: true },
    ]);
  });

  it('reports operators that cannot apply instead of dropping them silently', () => {
    const q = parseSearchQuery('has:nothing is:pinned before:someday during:2026-02-30 tag:""', ['tag']);
    expect(q.terms).toEqual([]);
    expect(q.problems.map((p) => p.raw)).toEqual(['has:nothing', 'is:pinned', 'before:someday', 'during:2026-02-30', 'tag:""']);
  });

  it('leaves other word:value text, such as URLs, as free text', () => {
    expect(parseSearchQuery('https://example.com note:x').words).toBe('https://example.com note:x');
  });

  it('reads dates as local-time days, months and years', () => {
    expect(parsePeriod('2026-09-01')).toEqual({ start: new Date(2026, 8, 1).getTime(), end: new Date(2026, 8, 2).getTime() });
    expect(parsePeriod('2026-12')).toEqual({ start: new Date(2026, 11, 1).getTime(), end: new Date(2027, 0, 1).getTime() });
    expect(parsePeriod('2026')).toEqual({ start: new Date(2026, 0, 1).getTime(), end: new Date(2027, 0, 1).getTime() });
    expect(parsePeriod('2026-13')).toBeNull();
  });

  it('cuts a query into the spans the field draws, rejoining to the exact text', () => {
    const texts = ['', 'cats', 'cats from:theo  -has:link x', 'in:"two words" has:nothing', 'https://a.b note:x tag:y', 'cats from:', 'from:"Ada L', 'during:2026 is:'];
    for (const t of texts) {
      expect(searchQuerySpans(t, ['tag']).map((s) => (s.kind === 'text' ? s.text : s.key + s.value)).join('')).toBe(t);
    }
    expect(searchQuerySpans('cats from:theo  -has:link x')).toEqual([
      { kind: 'text', text: 'cats ' },
      { kind: 'term', key: 'from:', value: 'theo', state: 'ok' },
      { kind: 'text', text: '  ' },
      { kind: 'term', key: '-has:', value: 'link', state: 'ok' },
      { kind: 'text', text: ' x' },
    ]);
    expect(searchQuerySpans('in:"two words" has:nothing').map((s) => s.kind === 'term' && s.state)).toEqual(['ok', false, 'problem']);
    expect(searchQuerySpans('https://a.b note:x tag:y', ['tag']).map((s) => s.kind)).toEqual(['text', 'term']);
    expect(searchQuerySpans('cats from:').at(-1)).toEqual({ kind: 'term', key: 'from:', value: '', state: 'typing' });
    expect(searchQuerySpans('from:"Ada L')).toEqual([{ kind: 'term', key: 'from:', value: '"Ada L', state: 'typing' }]);
  });

  it('builds no SQL for a problem operator', () => {
    expect(parseSearch('before:someday').where).toHaveLength(0);
  });

  it('stores saved searches trimmed, unique and non-empty', () => {
    expect(normalizeSavedSearches([' from:theo ', 'from:theo', '', 3, 'has:link'])).toEqual(['from:theo', 'has:link']);
    expect(normalizeSavedSearches('nope')).toEqual([]);
  });

  it('reads an unknown sort as newest first', () => {
    expect(normalizeSearchSort('oldest')).toBe('oldest');
    expect(normalizeSearchSort('sideways')).toBe('newest');
  });
});

describe('search operators against the archive', () => {
  let db: Db;
  let archive: Archive;
  const hits = (q: string): string[] =>
    searchMessages(db, q, 50, 'relevance')
      .map((h) => h.snippet.replaceAll(SEARCH_MATCH_START, '').replaceAll(SEARCH_MATCH_END, ''))
      .sort();

  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c1', name: 'general' }, { id: 'c2', name: 'trading', guildId: 'g2' }], {
      guilds: [
        { id: 'g1', name: 'Home' },
        { id: 'g2', name: 'Markets' },
      ],
    });
    archive.ingestMessages([
      rawMessage('c1', sept(1), 'alpha one'),
      rawMessage('c1', sept(2), 'alpha two', { author: { id: 'u2', username: 'bob', global_name: null }, member: { nick: 'Theo' } }),
      rawMessage('c2', sept(3), 'alpha three', { edited_timestamp: new Date(sept(3) + 1).toISOString() }),
      rawMessage('c2', sept(20), 'alpha four'),
    ], ARRIVAL.gateway);
  });

  it('matches from: on a server nickname and on an exact user id', () => {
    expect(hits('alpha from:theo')).toEqual(['alpha two']);
    expect(hits('from:<@u2>')).toEqual(['alpha two']);
  });

  it('names each hit\'s author by id and avatar, with words and without', () => {
    db.prepare("UPDATE users SET avatar = 'hash2' WHERE id = 'u2'").run();
    for (const q of ['alpha two', 'from:<@u2>']) {
      expect(searchMessages(db, q, 1, 'relevance')[0]).toMatchObject({ authorId: 'u2', authorName: 'Theo', authorAvatar: 'hash2' });
    }
  });

  it('gives a short hit its whole text with line breaks, and a long one a window that keeps its link whole', () => {
    const link = '[post](https://example.com/a/very/long/path/to/a/post/123456789)';
    archive.ingestMessages([
      rawMessage('c1', sept(4), 'quartz first line\n> quoted second'),
      rawMessage('c1', sept(5), `${'filler '.repeat(30)}${link} jasper ${'tail '.repeat(30)}`),
    ], ARRIVAL.gateway);
    expect(hits('quartz')).toEqual(['quartz first line\n> quoted second']);
    const [long] = hits('jasper');
    expect(long).toContain(`${link} jasper`);
    expect(long!.startsWith('…') && long!.endsWith('…')).toBe(true);
  });

  it('negates an operator even when the author has no display name', () => {
    expect(hits('alpha -from:alice')).toEqual(['alpha two']);
  });

  it('filters by server, edit and deletion state', () => {
    expect(hits('alpha server:markets')).toEqual(['alpha four', 'alpha three']);
    expect(hits('alpha is:edited')).toEqual(['alpha three']);
    const [four] = searchMessages(db, 'four', 1, 'relevance');
    archive.markDeleted('c2', four!.messageId, sept(21));
    expect(hits('alpha is:deleted')).toEqual(['alpha four']);
    expect(hits('alpha -is:deleted')).toEqual(['alpha one', 'alpha three', 'alpha two']);
  });

  it('orders matches by time before the limit, newest or oldest first; relevance without words lists newest first', () => {
    const inOrder = (q: string, sort: SearchSort, limit = 50): string[] =>
      searchMessages(db, q, limit, sort).map((h) => h.snippet.replaceAll(SEARCH_MATCH_START, '').replaceAll(SEARCH_MATCH_END, ''));
    expect(inOrder('alpha', 'newest')).toEqual(['alpha four', 'alpha three', 'alpha two', 'alpha one']);
    expect(inOrder('alpha', 'oldest', 2)).toEqual(['alpha one', 'alpha two']);
    expect(inOrder('alpha', 'newest', 2)).toEqual(['alpha four', 'alpha three']);
    expect(inOrder('server:markets', 'oldest')).toEqual(['alpha three', 'alpha four']);
    expect(inOrder('server:markets', 'relevance')).toEqual(['alpha four', 'alpha three']);
  });

  it('bounds by before:, after: and during: in local time', () => {
    expect(hits('alpha before:2026-09-02')).toEqual(['alpha one']);
    expect(hits('alpha after:2026-09-02')).toEqual(['alpha four', 'alpha three']);
    expect(hits('alpha during:2026-09-03')).toEqual(['alpha three']);
    expect(hits('alpha during:2026-09')).toHaveLength(4);
  });
});

describe('search reads what a message links to', () => {
  const POST = 'https://x.com/someone/status/1000000000000000001';
  const POST_URL = 'https://x.com/i/status/1000000000000000001';
  const TWEET = 'Turns out “the project” is just Coach Zorbington building a secret Minecraft city';
  let db: Db;
  let archive: Archive;
  const found = (q: string): string[] => searchMessages(db, q, 50, 'relevance').map((h) => h.messageId).sort();
  const fts = (): number => db.prepare('SELECT COUNT(*) FROM fts_links').pluck().get() as number;

  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: 'c1', name: 'general' }]);
  });

  it("finds an embed fixer's preview, and the message sharing the same post", () => {
    const shared = rawMessage('c1', sept(1), POST);
    const fixer = rawMessage('c1', sept(1) + 1, '[Tweet](https://fxtwitter.com/someone/status/1000000000000000001)', {
      author: { id: 'bot', username: 'FixTweet', global_name: null, bot: true },
      embeds: [{ type: 'rich', url: 'https://fxtwitter.com/someone/status/1000000000000000001', description: TWEET }],
    });
    archive.ingestMessages([shared, fixer], ARRIVAL.gateway);
    expect(found('coach zorbington')).toEqual([shared.id, fixer.id].sort());
    const [hit] = searchMessages(db, 'minecraft', 1, 'relevance');
    expect(hit!.snippet).toContain(`${SEARCH_MATCH_START}Minecraft${SEARCH_MATCH_END}`);
  });

  it("finds a preview that arrives later, and a plugin's fetched text over it", () => {
    const m = rawMessage('c1', sept(1), POST);
    archive.ingestMessages([m], ARRIVAL.gateway);
    expect(found('zorbington')).toEqual([]);
    archive.applyUpdate({ id: m.id, channel_id: m.channel_id, embeds: [{ url: POST, title: 'a post', description: TWEET }] });
    expect(found('zorbington')).toEqual([m.id]);

    storeLinkText(db, POST_URL, 'links', 'Full post: the coach goes voxel');
    expect(found('voxel')).toEqual([m.id]);
    expect(found('zorbington')).toEqual([]);
    db.prepare('DELETE FROM link_texts WHERE url = ?').run(POST_URL);
    expect(found('zorbington')).toEqual([m.id]);
  });

  it('keeps one row per texted link through rebuilds', () => {
    archive.ingestMessages([rawMessage('c1', sept(1), POST, { embeds: [{ url: POST, description: TWEET }] })], ARRIVAL.gateway);
    refreshLinkSearch(db);
    expect(fts()).toBe(1);
    db.exec('DELETE FROM message_links; DELETE FROM links;');
    expect(fts()).toBe(0);
  });
});
