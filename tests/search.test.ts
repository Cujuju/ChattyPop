// Search syntax and archive filtering.
import { beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_MATCH_END, SEARCH_MATCH_START } from '@shared/contract';
import { normalizeSavedSearches, parsePeriod, parseSearchQuery } from '@shared/searchQuery';
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

  it('builds no SQL for a problem operator', () => {
    expect(parseSearch('before:someday').where).toHaveLength(0);
  });

  it('stores saved searches trimmed, unique and non-empty', () => {
    expect(normalizeSavedSearches([' from:theo ', 'from:theo', '', 3, 'has:link'])).toEqual(['from:theo', 'has:link']);
    expect(normalizeSavedSearches('nope')).toEqual([]);
  });
});

describe('search operators against the archive', () => {
  let db: Db;
  let archive: Archive;
  const hits = (q: string): string[] =>
    searchMessages(db, q, 50)
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

  it('negates an operator even when the author has no display name', () => {
    expect(hits('alpha -from:alice')).toEqual(['alpha two']);
  });

  it('filters by server, edit and deletion state', () => {
    expect(hits('alpha server:markets')).toEqual(['alpha four', 'alpha three']);
    expect(hits('alpha is:edited')).toEqual(['alpha three']);
    const [four] = searchMessages(db, 'four', 1);
    archive.markDeleted('c2', four!.messageId, sept(21));
    expect(hits('alpha is:deleted')).toEqual(['alpha four']);
    expect(hits('alpha -is:deleted')).toEqual(['alpha one', 'alpha three', 'alpha two']);
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
  const found = (q: string): string[] => searchMessages(db, q, 50).map((h) => h.messageId).sort();
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
    const [hit] = searchMessages(db, 'minecraft', 1);
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
