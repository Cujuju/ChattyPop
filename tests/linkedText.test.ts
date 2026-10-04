// A message's links are judged by their text (Discord's preview, or a linked post's text a plugin stored when Discord sent
// none), and a cashtag settles the Trading label without Jev.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { ARRIVAL } from '../src/core/arrival';
import { CLASSES, hasCashtag, registerClasses } from '../src/core/jev/classes';
import { linkTexts } from '../src/core/laterMigrations';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { OWNER, settleAsync, tempDb } from './helpers';
import { ruleHarness, type Harness } from './ruleHarness';

const TRADING = CLASSES.find((c) => c.subject === 'class:trading')!.subject;
const preview = (url: string, title: string, description?: string) => ({ embeds: [{ url, title, description }] });

let h: Harness;
const told = (i: number): string => (h.jev.requests[i]!.state as { message: string }).message;

beforeAll(() => registerClasses());
beforeEach(() => {
  h = ruleHarness();
  h.matcher.setSelf(OWNER);
  h.jev.on.messageClasses = true;
});

describe('Jev reads what a message links to', () => {
  it('a preview that came with the message is part of it', async () => {
    h.say('https://example.com/a', { extra: preview('https://example.com/a', 'Fed cuts rates', 'Stocks rally') });
    await settleAsync();
    expect(told(0)).toContain('linked post: Fed cuts rates Stocks rally');
  });

  it('a preview that comes later has the message judged again, once', async () => {
    const m = h.say('https://example.com/b');
    await settleAsync();
    expect(h.jev.requests).toHaveLength(1);
    expect(told(0)).not.toContain('linked post');

    h.archive.applyUpdate({ id: m.id, channel_id: m.channel_id, ...preview('https://example.com/b', 'Oil spikes') });
    await settleAsync();
    expect(h.jev.requests).toHaveLength(2);
    expect(told(1)).toContain('linked post: Oil spikes');

    // Nothing new to read: no further request.
    h.archive.applyUpdate({ id: m.id, channel_id: m.channel_id, ...preview('https://example.com/b', 'Oil spikes') });
    h.archive.ingestMessages([{ ...m, ...preview('https://example.com/b', 'Oil spikes') }], ARRIVAL.sync);
    await settleAsync();
    expect(h.jev.requests).toHaveLength(2);
  });

  it('a preview a history fetch brings has the message judged again', async () => {
    const m = h.say('https://example.com/c');
    await settleAsync();
    h.archive.ingestMessages([{ ...m, ...preview('https://example.com/c', 'Rates hold') }], ARRIVAL.sync);
    await settleAsync();
    expect(h.jev.requests).toHaveLength(2);
    expect(told(1)).toContain('linked post: Rates hold');
  });
});

describe('a cashtag settles the Trading label', () => {
  const tradingRow = (id: string) => h.db.prepare('SELECT value, model FROM jev_judgments WHERE message_id = ? AND subject = ?').get(id, TRADING);

  it('in the message or its linked post: stored, and Jev is not asked', async () => {
    const own = h.say('$MDB getting hammered, down 16%');
    const linked = h.say('https://x.com/u/status/9', { extra: preview('https://x.com/u/status/9', 'Snorlax', '$MDB CEO poached by Zuck') });
    await settleAsync();
    for (const r of h.jev.requests) expect(Object.keys(r.questions)).not.toContain(TRADING);
    expect(tradingRow(own.id)).toEqual({ value: 1, model: 'text' });
    expect(tradingRow(linked.id)).toEqual({ value: 1, model: 'text' });
  });

  it('otherwise Jev is asked', async () => {
    h.say('paid $100 for the keyboard');
    await settleAsync();
    expect(Object.keys(h.jev.requests[0]!.questions)).toContain(TRADING);
  });

  it.each([
    ['$MDB down 16%', true],
    ['long $BRK.B', true],
    ['($TSLA)', true],
    ['$100 each', false],
    ['US$50', false],
    ['$$$', false],
    ['$lowercase', false],
    ['$TOOLONG', false],
    ['echo `$PATH`', false],
    ['```\nexport $HOME\n```', false],
  ])('%s → %s', (content, expected) => {
    expect(hasCashtag({ content, linked: '' })).toBe(expected);
  });
});

describe('link texts from posts fetched before Links was a plugin', () => {
  const texts = (db: ReturnType<typeof tempDb>) => db.prepare('SELECT url, source, text FROM link_texts').all();

  it("move over from x_posts: fetched posts' text only", () => {
    const db = tempDb();
    db.exec('DROP TABLE link_texts');
    const post = db.prepare('INSERT INTO x_posts (status_id, state, status_json, fetched_at) VALUES (?, ?, ?, 0)');
    post.run('1', 'ok', JSON.stringify({ text: 'Fed cuts rates' }));
    post.run('2', 'ok', JSON.stringify({ text: '' }));
    post.run('3', 'unavailable', null);
    linkTexts(db);
    expect(texts(db)).toEqual([{ url: 'https://x.com/i/status/1', source: 'links', text: 'Fed cuts rates' }]);
  });

  it('are skipped where Links already adopted x_posts', () => {
    const db = tempDb();
    db.prepare("INSERT INTO x_posts (status_id, state, status_json, fetched_at) VALUES ('1', 'ok', ?, 0)").run(JSON.stringify({ text: 'Fed cuts rates' }));
    // Links' adoption record for the table, as its descriptor declares it.
    const links: PluginDescriptor = { manifest: { id: 'links', name: 'Links', version: '1', description: '' }, adopts: { tables: { x_posts: 'x_posts' } } };
    adoptBundledData(db, [links]);
    db.exec('DROP TABLE link_texts');
    linkTexts(db);
    expect(texts(db)).toEqual([]);
  });
});
