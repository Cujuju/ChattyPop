// Plugin search shares the app's indexes, with explicit scopes and no operator parsing.
import { describe, expect, it, onTestFinished } from 'vitest';
import { ARCHIVE_SEARCH_MAX, defineCorePlugin, type CoreContext } from '@plugin-sdk/core';
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
  return { t, ctx, search: (query = 'quartz', opts = {}) => ctx.archive.search(query, { channelIds: ['c1', 'c2', 'c3'], limit: ARCHIVE_SEARCH_MAX, ...opts }) };
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
