import { describe, expect, it, vi } from 'vitest';
import { compressRawJson, setSetting } from '../src/core/db';
import { archiveAsync } from '../src/core/plugins/archiveAsync';
import { closeArchiveReads } from '../src/core/reads/archiveReads';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb } from './helpers';

describe('helper link preview projection', () => {
  it('keeps earliest bot preference, compressed payloads, privacy and scope, returning one card per selected link', async () => {
    const db = tempDb(); seedArchiveViews(db);
    const payload = (title: string, bot: boolean) => compressRawJson(JSON.stringify({ author: { bot }, embeds: [{ type: 'rich', url: 'https://example.com/open', title }] }));
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(payload('Human', false), 'm-open');
    db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(payload('Hidden bot', true), 'm-hide');
    db.prepare("INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES ('later-bot', 'c-open', 'u1', 9, '', ?)").run(payload('Visible bot', true));
    db.prepare("INSERT INTO message_links (message_id, link_id) VALUES ('later-bot', 1)").run();
    const read = archiveAsync(() => db, () => true);
    try {
      const prepare = vi.spyOn(db, 'prepare');
      try {
        const cards = await read.linkPreviews([1, 2, 999]);
        expect(cards.size).toBeLessThanOrEqual(2);
        expect(cards.get(1)).toMatchObject({ source: 'm-hide', embed: { title: 'Hidden bot' } });
        expect(prepare).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); }
      setSetting(db, 'privacyMode', true);
      expect((await read.linkPreviews([1])).get(1)).toMatchObject({ source: 'later-bot', embed: { title: 'Visible bot' } });
      expect((await read.linkPreviews([1], { channelIds: ['c-open'], since: null, until: 1 })).get(1))
        .toMatchObject({ source: 'm-open', embed: { title: 'Human' } });
      expect(await read.linkPreviews([1], { channelIds: ['c-open'], since: 10, until: null })).toEqual(new Map());
      const cancelled = new AbortController(); cancelled.abort(new Error('Preview superseded'));
      await expect(read.linkPreviews([1], undefined, { signal: cancelled.signal })).rejects.toBe(cancelled.signal.reason);
    } finally { await closeArchiveReads(db); db.close(); }
  });
});
