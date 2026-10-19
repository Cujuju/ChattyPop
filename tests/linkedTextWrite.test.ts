import { expect, it, onTestFinished, vi } from 'vitest';
import { seedArchive, tempDb, rawMessage } from './helpers';
import { ARRIVAL } from '../src/core/arrival';
import { textedLinkCount } from '../src/core/queries/messageText';
import { setSetting } from '../src/core/db';
import { SETTINGS_KEYS } from '@shared/settings';

const START = Date.UTC(2026, 0, 1);
const URL = 'https://example.test/article';

it('reuses linked-text statements and observes late previews inside the writer transaction', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  const linked = vi.fn(() => expect(db.inTransaction).toBe(true));
  const archive = seedArchive(db, [{ id: 'channel' }], { onLinkedText: linked });
  const message = rawMessage('channel', START, URL, { embeds: [] });
  archive.ingestMessages([message], ARRIVAL.sync);
  const prepare = vi.spyOn(db, 'prepare');
  archive.ingestMessages([message, message], ARRIVAL.sync);
  expect(linked).not.toHaveBeenCalled();
  archive.applyUpdate({ id: message.id, channel_id: 'channel', embeds: [{ url: URL, title: 'Late preview' }] });
  expect(linked).toHaveBeenCalledTimes(1);
  archive.applyUpdate({ id: message.id, channel_id: 'channel', embeds: [{ url: URL, title: 'Late preview' }] });
  expect(linked).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT COUNT(text)'))).toHaveLength(1);
});

it('keeps cached counts transactional across rollback, plugin precedence, edits and privacy', () => {
  const db = tempDb(); onTestFinished(() => { db.close(); });
  const archive = seedArchive(db, [{ id: 'channel' }, { id: 'hidden' }]);
  const message = rawMessage('channel', START, URL, { embeds: [] });
  archive.ingestMessages([message], ARRIVAL.sync);
  expect(textedLinkCount(db, message.id)).toBe(0);
  expect(() => db.transaction(() => {
    archive.applyUpdate({ id: message.id, channel_id: 'channel', embeds: [{ url: URL, title: 'Uncommitted' }] });
    expect(textedLinkCount(db, message.id)).toBe(1);
    throw new Error('rollback');
  })()).toThrow('rollback');
  expect(textedLinkCount(db, message.id)).toBe(0);
  db.prepare('INSERT INTO link_texts(url, source, text) VALUES (?, ?, ?)').run(URL, 'probe', 'Plugin text');
  expect(textedLinkCount(db, message.id)).toBe(1);
  archive.applyUpdate({ id: message.id, channel_id: 'channel', embeds: [{ url: URL, title: 'Preview' }] });
  expect(textedLinkCount(db, message.id)).toBe(1);
  archive.applyUpdate({ id: message.id, channel_id: 'channel', content: 'Edited without links', embeds: [] });
  expect(textedLinkCount(db, message.id)).toBe(0);
  archive.applyUpdate({ id: message.id, channel_id: 'channel', content: URL, embeds: [{ url: URL, title: 'Preview' }] });
  db.prepare("UPDATE channels SET hide_in_privacy = 1 WHERE id = 'channel'").run();
  setSetting(db, SETTINGS_KEYS.privacyMode, true);
  db.prepare('DELETE FROM link_texts WHERE url = ?').run(URL);
  expect(textedLinkCount(db, message.id)).toBe(0);
  setSetting(db, SETTINGS_KEYS.privacyMode, false);
  expect(textedLinkCount(db, message.id)).toBe(1);
});
