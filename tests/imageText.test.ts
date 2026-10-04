// Image text, the host's side: the images a message shows, derived text that skips Jev, and image readers told
// before matching.
import { beforeAll, describe, expect, it } from 'vitest';
import { Archive } from '../src/core/archive';
import { ARRIVAL } from '../src/core/arrival';
import { storeDerivedText } from '../src/core/derivedText';
import { CLASSES, registerClasses } from '../src/core/jev/classes';
import { messageImages, storeLinkImages } from '../src/core/messageImages';
import { addedTextArrival, textMessage } from '../src/core/queries/messageText';
import { OWNER, rawMessage, seedArchive, settleAsync, tempDb } from './helpers';
import { ruleHarness } from './ruleHarness';

describe('the images a message shows', () => {
  it('are its image attachments, its embeds’ pictures and the images plugins found for its links, each once', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    const m = rawMessage('c1', Date.now(), 'https://x.com/i/status/5', {
      attachments: [
        { id: 'a1', filename: 'shot.png', content_type: 'image/png', size: 10, url: 'https://cdn.discordapp.com/a1/shot.png', width: 800, height: 600 },
        { id: 'a2', filename: 'notes.txt', content_type: 'text/plain', size: 10, url: 'https://cdn.discordapp.com/a2/notes.txt' },
      ],
      embeds: [
        { type: 'image', url: 'https://i.example/c.png', thumbnail: { proxy_url: 'https://media.discordapp.net/c.png', width: 10, height: 20 } },
        { type: 'video', url: 'https://youtu.be/x', thumbnail: { proxy_url: 'https://media.discordapp.net/still.jpg' } },
        { type: 'rich', image: { proxy_url: 'https://media.discordapp.net/c.png' } },
      ],
    } as never);
    archive.ingestMessages([m], ARRIVAL.gateway);
    expect(storeLinkImages(db, 'https://x.com/i/status/5', 'links', [{ url: 'https://pbs.twimg.com/media/p.jpg', width: 1200, height: 900 }])).toEqual([m.id]);

    const images = messageImages(db, [m.id]).get(m.id)!;
    expect(images.map((i) => [i.source, i.url])).toEqual([
      ['attachment', 'https://cdn.discordapp.com/a1/shot.png'],
      ['embed', 'https://media.discordapp.net/c.png'],
      ['link', 'https://pbs.twimg.com/media/p.jpg'],
    ]);
    expect(images[0]).toMatchObject({ key: 'attachment:a1', attachment: { id: 'a1', status: 'pending' }, size: { width: 800, height: 600 } });
    // Setting a link's images again replaces them.
    storeLinkImages(db, 'https://x.com/i/status/5', 'links', []);
    expect(messageImages(db, [m.id]).get(m.id)!.map((i) => i.source)).toEqual(['attachment', 'embed']);
  });
});

describe('derived text that skips Jev', () => {
  const TRADING = CLASSES.find((c) => c.subject === 'class:trading')!.subject;
  beforeAll(() => registerClasses());

  it('applies the answers its text settles and asks Jev nothing; asked, Jev reads it', async () => {
    const h = ruleHarness();
    h.matcher.setSelf(OWNER);
    h.jev.on.messageClasses = true;
    const m = h.say('look at this');
    await settleAsync();
    expect(h.jev.requests).toHaveLength(1);

    storeDerivedText(h.db, m.id, 'imagetext:attachment:a1', 1, 'AAPL - O: 1 H: 2 L: 1 C: 2\n$AAPL');
    h.matcher.check(textMessage(h.db, m.id)!, addedTextArrival(h.db, m.id, Date.now()), false);
    await settleAsync();
    expect(h.jev.requests).toHaveLength(1);
    expect(h.db.prepare('SELECT value, model FROM jev_judgments WHERE message_id = ? AND subject = ?').get(m.id, TRADING)).toEqual({ value: 1, model: 'text' });

    h.matcher.check(textMessage(h.db, m.id)!, addedTextArrival(h.db, m.id, Date.now()), true);
    await settleAsync();
    expect(h.jev.requests).toHaveLength(2);
    expect((h.jev.requests[1]!.state as { message: string }).message).toContain('$AAPL');
  });
});

describe('the host tells image readers before matching', () => {
  it('a stored or updated message is shown before its text is matched, a re-fetched edit too', () => {
    const db = tempDb();
    const order: string[] = [];
    const archive = new Archive(db, (m) => order.push(`text ${m.content}`), undefined, (id) => order.push(`shown ${id}`));
    archive.upsertGuilds([{ id: 'g1', name: 'G' } as never]);
    archive.upsertChannels('g1', [{ id: 'c1', name: 'c1', type: 0 } as never]);
    archive.setOptIn('c1', true);
    const m = rawMessage('c1', Date.now(), 'one');
    archive.ingestMessages([m], ARRIVAL.gateway);
    archive.ingestMessages([{ ...m, content: 'two' }], ARRIVAL.sync);
    expect(order).toEqual([`shown ${m.id}`, 'text one', `shown ${m.id}`, 'text two']);
  });
});
