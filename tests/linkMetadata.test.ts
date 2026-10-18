// A URL's previews retain the supplying share across backfills, edits and scoped reads.
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defineCorePlugin, type ArchiveToolScope, type CoreContext } from '@plugin-sdk/core';
import { definePlugin } from '@plugin-sdk/shared';
import { testPlugin } from '@plugin-sdk/core/testing';
import { compressRawJson, migrate, type Db } from '../src/core/db';
import { addLinkMetadataSources } from '../src/core/derive/linkMetadata';
import { MIGRATIONS } from '../src/core/migrations';
import { searchMessages } from '../src/core/queries/search';
import { applyMigrations, rawMessage } from './helpers';

const URL = 'https://example.com/resource';
const START = Date.UTC(2026, 8, 1);
const probe = definePlugin({ manifest: { id: 'metaprobe', name: 'Read probe', version: '1', description: '' } });
const scope = (channelIds = ['open'], since: number | null = null, until: number | null = null): ArchiveToolScope => ({ channelIds, since, until });

function start() {
  let ctx!: CoreContext<typeof probe>;
  const t = testPlugin(defineCorePlugin(probe, (c) => { ctx = c; }), {
    archive: { channels: [{ id: 'open' }, { id: 'hidden', hidden: true }, { id: 'local', localOnly: true }, { id: 'local-thread', parentId: 'local' }, { id: 'other' }],
      messages: [{ channelId: 'open', ts: START, content: URL }] },
    ai: { providers: [{ id: 'localreader', local: true, provider: {
      id: 'localreader', maxInputChars: 1000, complete: async () => ({ text: '' }), listModels: async () => [],
    } }] },
  });
  onTestFinished(() => t.dispose());
  const preview = (channelId: string, extra: Record<string, unknown> = {}) => t.archive.arrive([{
    channelId, ts: START + 1, content: URL, extra: { embeds: [{ url: URL, title: 'quartz title', description: 'obsidian details', provider: { name: 'Example' }, ...extra }] },
  }])[0]!;
  const read = (window = scope(), reader?: Parameters<typeof ctx.archive.linksSql>[1]) =>
    t.db.prepare(`SELECT title, description, thumbnail_url, site FROM (${ctx.archive.linksSql(window, reader)})`).get();
  const search = (channelIds = ['open'], options = {}) => ctx.archive.search('quartz', { channelIds, limit: 100, ...options });
  const appSearch = (query = 'quartz') => searchMessages(t.db as Db, query, 10, 'relevance');
  return { t, ctx, preview, read, search, appSearch };
}

describe('link metadata provenance', () => {
  it('hides another channel’s preview in views, linked text, app search and plugin search', () => {
    const h = start();
    h.preview('hidden', { thumbnail: { proxy_url: 'https://images.example/private.png' } });
    h.t.archive.setPrivacyMode(true);
    for (const view of ['archive_links', 'archive_all_links']) {
      expect(h.t.db.prepare(`SELECT title, description, thumbnail_url, site FROM ${view}`).get()).toEqual({ title: null, description: null, thumbnail_url: null, site: null });
    }
    expect(h.t.db.prepare("SELECT linked FROM archive_messages WHERE channel_id = 'open'").pluck().get()).toBe('');
    expect(h.appSearch()).toEqual([]);
    expect(h.search(['open', 'hidden'])).toEqual([]);
    expect(h.read()).toMatchObject({ title: null, site: null });
    h.t.archive.setPrivacyMode(false);
    expect(h.search(['open', 'hidden'])).toHaveLength(2);
    expect(h.read(scope(['open', 'hidden']))).toMatchObject({ title: 'quartz title', thumbnail_url: 'https://images.example/private.png', site: 'Example' });
  });

  it('requires the metadata source itself to lie in the caller’s channels and time window', () => {
    const h = start();
    h.preview('other');
    expect(h.read()).toMatchObject({ title: null });
    expect(h.search()).toEqual([]);
    expect(h.appSearch('quartz in:open')).toEqual([]);
    expect(h.search(['open', 'other'], { until: START })).toEqual([]);
    expect(h.read(scope(['open', 'other'], null, START))).toMatchObject({ title: null });
    expect(h.search(['open', 'other'])).toHaveLength(2);
    expect(h.read(scope(['open', 'other']))).toMatchObject({ title: 'quartz title' });
  });

  it.each(['local', 'local-thread'])('excludes %s metadata for hosted readers, while a local reader and display can use it', (channel) => {
    const h = start();
    h.preview(channel);
    const ids = ['open', channel];
    expect(h.read(scope(ids))).toMatchObject({ title: null });
    expect(h.search(ids)).toEqual([]);
    expect(h.read(scope(ids), { provider: 'localreader' })).toMatchObject({ title: 'quartz title' });
    expect(h.search(ids, { reader: { provider: 'localreader' } })).toHaveLength(2);
    expect(h.read(scope(ids), 'display')).toMatchObject({ title: 'quartz title' });
  });

  it('preserves normal titles and assigns different sources to independently filled fields', () => {
    const h = start();
    const title = h.preview('open', { description: null, provider: null });
    const details = h.preview('other', { title: null });
    expect(h.read()).toMatchObject({ title: 'quartz title', description: null, site: null });
    expect(h.read(scope(['open', 'other']))).toMatchObject({ title: 'quartz title', description: 'obsidian details', site: 'Example' });
    const sources = JSON.parse(h.t.db.prepare('SELECT metadata_sources FROM links').pluck().get() as string);
    expect(sources).toMatchObject({ title: { messageId: title, channelId: 'open' }, description: { messageId: details, channelId: 'other' } });
  });

  it('keeps provenance on source edits and stops trusting a share after its link is removed', () => {
    const h = start();
    const id = h.preview('open');
    h.t.archive.arrive([{ id, channelId: 'open', ts: START + 1, content: URL, extra: { embeds: [{ url: URL, title: 'updated quartz' }] } }]);
    expect(h.read()).toMatchObject({ title: 'updated quartz' });
    h.t.archive.arrive([{ id, channelId: 'open', ts: START + 1, content: 'removed', extra: { embeds: [] } }]);
    expect(h.read()).toMatchObject({ title: null });
    expect(h.search()).toEqual([]);
  });

  it('adopts a new supplying share when a legacy field’s origin is unknown', () => {
    const h = start();
    h.preview('hidden');
    h.t.db.prepare('UPDATE links SET metadata_sources = NULL').run();
    expect(h.read()).toMatchObject({ title: null });
    const id = h.preview('open', { title: 'fresh quartz' });
    expect(h.read()).toMatchObject({ title: 'fresh quartz' });
    expect(JSON.parse(h.t.db.prepare('SELECT metadata_sources FROM links').pluck().get() as string).title)
      .toEqual({ messageId: id, channelId: 'open' });
  });

  it('does not borrow hidden-reference sources from a visible channel', () => {
    const h = start();
    h.t.archive.arrive([{ channelId: 'open', ts: START + 2, content: `${URL} <#hidden>`, extra: { embeds: [{ url: URL, title: 'quartz' }] } }]);
    h.t.archive.setPrivacyMode(true);
    expect(h.read()).toMatchObject({ title: null });
    expect(h.search()).toEqual([]);
  });

  it('preserves independent plugin page text when a preview source is inaccessible', () => {
    const h = start();
    h.preview('hidden');
    h.ctx.archive.linkText.set(URL, 'quartz public page');
    h.t.archive.setPrivacyMode(true);
    expect(h.search()).toHaveLength(1);
    expect(h.appSearch()[0]?.snippet).toContain('public page');
  });
});

describe('legacy link metadata upgrade', () => {
  it('backfills unique compressed evidence, leaving ambiguous and missing sources unknown', () => {
    const db = new Database(':memory:');
    onTestFinished(() => { db.close(); });
    const before = MIGRATIONS.indexOf(addLinkMetadataSources);
    applyMigrations(db, 0, before);
    const addMessage = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
    const addLink = db.prepare("INSERT INTO links (id, url, platform, title, first_message_id, first_channel_id, first_author_id, first_ts) VALUES (?, ?, 'other', 'quartz', ?, 'open', 'u1', ?)");
    const addShare = db.prepare('INSERT INTO message_links (message_id, link_id) VALUES (?, ?)');
    for (const index of [1, 2, 3]) {
      const url = `${URL}/${index}`;
      const m = rawMessage('open', START + index, url, { embeds: [{ url, title: 'quartz' }] });
      addMessage.run(m.id, m.channel_id, 'u1', START + index, url, index === 3 ? null : compressRawJson(JSON.stringify(m)));
      addLink.run(index, url, m.id, START + index);
      addShare.run(m.id, index);
      if (index === 2) {
        const other = { ...m, id: 'ambiguous', channel_id: 'other' };
        addMessage.run(other.id, other.channel_id, 'u1', START + index, url, JSON.stringify(other));
        addShare.run(other.id, index);
      }
    }
    migrate(db);
    expect(db.prepare("SELECT json_extract(metadata_sources, '$.title.channelId') FROM links ORDER BY id").pluck().all()).toEqual(['open', null, null]);
    expect(db.prepare('SELECT title FROM archive_links ORDER BY id').pluck().all()).toEqual(['quartz', null, null]);
  });
});
