// Plugin search shares the app's indexes, with explicit scopes and no operator parsing.
import { describe, expect, it, onTestFinished } from 'vitest';
import { ARCHIVE_SEARCH_GROUPS_MAX, ARCHIVE_SEARCH_MAX, defineCorePlugin, type ArchiveSearchGroup, type ArchiveSearchOptions, type CoreContext } from '@plugin-sdk/core';
import { definePlugin } from '@plugin-sdk/shared';
import { testPlugin } from '@plugin-sdk/core/testing';
import { snowflakeFromMs } from '@shared/discord';

/** Fixed fixture times, a millisecond apart for inclusive boundary checks. */
const START = Date.UTC(2026, 8, 1);
const messageId = (n: number): string => snowflakeFromMs(START + n - 1);
const probe = definePlugin({ manifest: { id: 'searchprobe', name: 'Search probe', version: '1', description: '' } });

function start() {
  let ctx!: CoreContext<typeof probe>;
  const t = testPlugin(defineCorePlugin(probe, (c) => { ctx = c; }), {
    archive: {
      channels: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', hidden: true }],
      messages: [
        { id: messageId(1), channelId: 'c1', ts: START, content: 'quartz', authorId: 'u1' },
        { id: messageId(2), channelId: 'c1', ts: START + 1, content: '', authorId: 'u2' },
        { id: messageId(3), channelId: 'c2', ts: START + 2, content: 'https://example.com/item', extra: { embeds: [{ url: 'https://example.com/item', title: 'quartz' }] } },
        { id: messageId(4), channelId: 'c3', ts: START + 3, content: 'quartz' },
      ],
    },
  });
  onTestFinished(() => t.dispose());
  ctx.archive.derivedText.settle(messageId(2), { key: 'text', order: 1, text: 'quartz', queuedAt: START });
  return { t, ctx,
    search: (query = 'quartz', opts: Partial<ArchiveSearchOptions> = {}) => ctx.archive.search(query, { channelIds: ['c1', 'c2', 'c3'], limit: ARCHIVE_SEARCH_MAX, ...opts }),
    count: (query: string | null = 'quartz', opts: Partial<ArchiveSearchOptions> = {}, group: ArchiveSearchGroup = 'channel') =>
      ctx.archive.searchCount(query, { channelIds: ['c1', 'c2', 'c3'], limit: ARCHIVE_SEARCH_GROUPS_MAX, ...opts }, group),
  };
}

describe('plugin archive search', () => {
  it('finds message, derived and link text, deduplicating a message across indexes', () => {
    const h = start();
    expect(h.search().map((r) => r.messageId).sort()).toEqual([messageId(1), messageId(2), messageId(3), messageId(4)]);
    h.ctx.archive.derivedText.settle(messageId(1), { key: 'other', order: 1, text: 'quartz', queuedAt: START });
    expect(h.search().map((r) => r.messageId).sort()).toEqual([messageId(1), messageId(2), messageId(3), messageId(4)]);
    expect(h.search('quar').map((r) => r.messageId).sort()).toEqual([messageId(1), messageId(2), messageId(3), messageId(4)]);
    expect(h.search('quartz', { limit: 1 })).toHaveLength(1);
  });

  it('applies channel, author and inclusive time bounds in every index', () => {
    const h = start();
    expect(h.search('quartz', { channelIds: ['c1'], authorIds: ['u2'], since: START + 1, until: START + 1 }))
      .toEqual([{ messageId: messageId(2), channelId: 'c1', ts: START + 1 }]);
    expect(h.search('quartz', { channelIds: ['c2'], since: START + 2, until: START + 2 }).map((r) => r.messageId)).toEqual([messageId(3)]);
    expect(h.search('quartz', { since: START, until: START }).map((r) => r.messageId)).toEqual([messageId(1)]);
    expect(h.search('quartz', { authorIds: [] })).toEqual([]);
    expect(h.search('quartz', { channelIds: [] })).toEqual([]);
    expect(h.search('quartz', { since: START + 4 })).toEqual([]);
  });

  it('finds messages matching one distinctive word in a full question', () => {
    const h = start();
    expect(h.search('What did people decide about the quartz date?').map((r) => r.messageId).sort())
      .toEqual([messageId(1), messageId(2), messageId(3), messageId(4)]);
  });

  it('ranks a message matching two query words above one matching one', () => {
    const h = start();
    h.t.archive.arrive([
      { id: messageId(5), channelId: 'c1', ts: START + 4, content: 'launch agenda' },
      { id: messageId(6), channelId: 'c1', ts: START + 5, content: 'launch date' },
    ]);
    expect(h.search('launch date').map((r) => r.messageId)).toEqual([messageId(6), messageId(5)]);
  });

  it('returns no hits for stopwords and short words only', () => {
    const h = start();
    h.t.archive.arrive([{ id: messageId(5), channelId: 'c1', ts: START + 4, content: 'What did the AI do?' }]);
    expect(h.search('what did the')).toEqual([]);
    expect(h.search('AI do')).toEqual([]);
  });

  it('evaluates privacy on each search, including hidden references in visible messages', () => {
    const h = start();
    h.t.archive.arrive([{ id: messageId(5), channelId: 'c1', content: 'quartz <#c3>', ts: START + 4 }]);
    h.t.archive.setPrivacyMode(true);
    expect(h.search().map((r) => r.messageId).sort()).toEqual([messageId(1), messageId(2), messageId(3)]);
    h.t.archive.setPrivacyMode(false);
    expect(h.search()).toHaveLength(5);
  });

  it('takes free text only, and returns no hits without words or after unload', async () => {
    const h = start();
    expect(h.search(' \t ')).toEqual([]);
    expect(h.search('quartz from:u2')).toEqual(h.search());
    await h.t.off();
    expect(h.search()).toEqual([]);
  });

  it.each([0, -1, ARCHIVE_SEARCH_MAX + 1, 1.5, NaN, Infinity])('rejects invalid limit %s', (limit) => {
    expect(() => start().search('quartz', { limit })).toThrow(RangeError);
  });
});

describe('plugin archive grouped counts', () => {
  it('counts every text index once, using the same query and scope as search', () => {
    const h = start();
    h.ctx.archive.derivedText.settle(messageId(1), { key: 'duplicate', order: 1, text: 'quartz', queuedAt: START });
    h.ctx.archive.derivedText.settle(messageId(3), { key: 'duplicate-link', order: 1, text: 'quartz', queuedAt: START });
    h.ctx.archive.derivedText.settle(messageId(2), { key: 'duplicate-derived', order: 2, text: 'quartz', queuedAt: START });
    for (const query of ['quartz', 'quar', 'What did people decide about quartz?', 'quartz missing', 'quartz from:u2', 'what did the', '!!!', 'AI do']) {
      for (const scope of [{}, { channelIds: ['c1'] }, { authorIds: ['u2'] }, { since: START + 1, until: START + 1 },
        { channelIds: ['c2'], since: START + 2, until: START + 2 }, { channelIds: [] }, { authorIds: [] }, { since: START + 4 }]) {
        expect(h.count(query, scope).reduce((sum, r) => sum + r.count, 0)).toBe(h.search(query, scope).length);
      }
    }
    expect(h.count()).toMatchObject([{ key: 'c1', count: 2 }, { key: 'c2', count: 1 }, { key: 'c3', count: 1 }]);
  });

  it('checks live privacy for candidates in every index, including hidden-id mentions', () => {
    const h = start();
    h.t.archive.arrive([
      { id: messageId(5), channelId: 'c1', content: 'quartz <#c3>', ts: START + 4 },
      { id: messageId(6), channelId: 'c1', content: '<#c3>', ts: START + 5 },
      { id: messageId(7), channelId: 'c2', content: 'https://example.com/hidden <#c3>', ts: START + 6,
        extra: { embeds: [{ url: 'https://example.com/hidden', title: 'quartz' }] } },
    ]);
    h.ctx.archive.derivedText.settle(messageId(6), { key: 'mention', order: 1, text: 'quartz', queuedAt: START });
    h.ctx.archive.derivedText.settle(messageId(4), { key: 'hidden', order: 1, text: 'quartz', queuedAt: START });
    h.t.archive.setPrivacyMode(true);
    expect(h.count()).toMatchObject([{ key: 'c1', count: 2 }, { key: 'c2', count: 1 }]);
    expect(h.count().reduce((sum, r) => sum + r.count, 0)).toBe(h.search().length);
    h.t.archive.setPrivacyMode(false);
    expect(h.count().reduce((sum, r) => sum + r.count, 0)).toBe(7);
    expect(h.search()).toHaveLength(7);
  });

  it('bounds groups without capping messages and keeps ties ordered by key', () => {
    const h = start();
    const extra = ARCHIVE_SEARCH_MAX + 5;
    h.t.archive.arrive(Array.from({ length: extra }, (_, i) => ({ id: messageId(i + 5), channelId: 'c1', ts: START + i + 4, content: 'quartz' })));
    expect(h.search()).toHaveLength(ARCHIVE_SEARCH_MAX);
    expect(h.count('quartz', { limit: 1 })).toMatchObject([{ key: 'c1', count: extra + 2 }]);
    expect(h.count('quartz', { channelIds: ['c2', 'c3'] }).map((r) => r.key)).toEqual(['c2', 'c3']);
  });

  it('counts textless messages only with a null query and supplies scoped author names', () => {
    const h = start();
    h.t.archive.arrive([{ id: messageId(5), channelId: 'c1', ts: START + 4, content: '', authorId: 'textless', authorName: 'Textless' }]);
    expect(h.count(null, { authorIds: ['textless'] }, 'author')).toEqual([{ key: 'textless', count: 1, name: 'Textless', username: 'Textless' }]);
    expect(h.count('', { authorIds: ['textless'] })).toEqual([]);
    expect(h.count('quartz', { authorIds: ['textless'] })).toEqual([]);
  });

  it.each(['day', 'hour', 'weekday'] as const)('groups %s in the local timezone', (group) => {
    const h = start();
    const date = new Date(START);
    const key = group === 'day' ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      : group === 'hour' ? String(date.getHours()).padStart(2, '0') : String(date.getDay());
    expect(h.count('quartz', {}, group)).toEqual([{ key, count: 4, name: key, username: null }]);
  });

  it('returns no groups after unload', async () => {
    const h = start();
    await h.t.off();
    expect(h.count()).toEqual([]);
    expect(h.count(null)).toEqual([]);
  });

  it.each([0, -1, ARCHIVE_SEARCH_GROUPS_MAX + 1, 1.5, NaN, Infinity])('rejects invalid group limit %s', (limit) => {
    expect(() => start().count('quartz', { limit })).toThrow(RangeError);
  });

  it('rejects unknown groups', () => {
    expect(() => start().count('quartz', {}, 'constructor' as ArchiveSearchGroup)).toThrow(RangeError);
  });
});
