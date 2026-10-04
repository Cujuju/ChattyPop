// Message parts: what a message shows that a plugin can make text for, notes keyed by part (drawn under attachments and
// embeds), and derived text read per part.
import { afterEach, describe, expect, it } from 'vitest';
import { ARRIVAL } from '../src/core/arrival';
import { partNotes, registerAttachmentNotes, registerPartNotes, unregisterAttachmentNotes } from '../src/core/attachmentNotes';
import { partTexts, storeDerivedText, tagDerivedParts } from '../src/core/derivedText';
import { embedPartKeys, messageParts } from '../src/core/messageParts';
import type { ArchiveEmbed } from '../src/shared/types/archive';
import { messagesByIds } from '../src/core/queries/messages';
import { rawMessage, seedArchive, tempDb } from './helpers';

const VIDEO = 'https://images-ext-1.discordapp.net/external/v/clip.mp4';
const STILL = 'https://images-ext-1.discordapp.net/external/t/still.jpg';

/** A message with every kind of part: audio, video and image files, a bot's video card (FxTwitter), a GIF and a YouTube link. */
function seeded() {
  const db = tempDb();
  const archive = seedArchive(db, [{ id: 'c1' }]);
  const m = rawMessage('c1', Date.now(), 'look', {
    attachments: [
      { id: 'a1', filename: 'voice-message.ogg', content_type: 'audio/ogg', size: 10, url: 'https://cdn.discordapp.com/a1.ogg' },
      { id: 'a2', filename: 'clip.mp4', content_type: 'video/mp4', size: 10, url: 'https://cdn.discordapp.com/a2.mp4' },
      { id: 'a3', filename: 'notes.txt', content_type: 'text/plain', size: 10, url: 'https://cdn.discordapp.com/a3.txt' },
    ],
    embeds: [
      { type: 'rich', url: 'https://fxtwitter.com/i/status/1', description: '詳細は分からない', thumbnail: { proxy_url: STILL }, video: { proxy_url: VIDEO, width: 1280, height: 664 } },
      { type: 'gifv', url: 'https://tenor.com/x', video: { proxy_url: 'https://media.discordapp.net/g.mp4' } },
      { type: 'video', url: 'https://youtu.be/x', title: 'A talk', video: { url: 'https://www.youtube.com/embed/x' } },
    ],
  } as never);
  archive.ingestMessages([m], ARRIVAL.gateway);
  return { db, id: m.id };
}

describe('the parts of a message', () => {
  it('are its media files, each embed’s text, pictures and sounding video; never a GIF’s or an unplayable video', () => {
    const { db, id } = seeded();
    expect(messageParts(db, [id]).get(id)!.map((p) => [p.key, p.kind])).toEqual([
      ['attachment:a1', 'audio'],
      ['attachment:a2', 'video'],
      ['embed-text:0', 'text'],
      [`embed:${STILL}`, 'image'],
      [`embed:${VIDEO}`, 'video'],
      ['embed-text:2', 'text'],
    ]);
  });
});

describe('notes by part', () => {
  afterEach(() => ['att', 'part'].forEach(unregisterAttachmentNotes));

  it('draw under the attachment or the embed they are of, in plugin build order', () => {
    const { db, id } = seeded();
    const note = (text: string) => ({ kind: 'k', state: 'done', label: 'l', text });
    registerPartNotes('part', 2, (ids) => new Map(ids.map((m) => [m, new Map([[`embed:${VIDEO}`, note('heard')], ['attachment:a1', note('translated')]])])));
    registerAttachmentNotes('att', 1, (ids) => new Map(ids.filter((a) => a === 'a1').map((a) => [a, note('said')])));
    expect(partNotes([{ id, attachmentIds: ['a1', 'a2'] }]).get(id)!.get('attachment:a1')!.map((n) => [n.pluginId, n.part, n.text])).toEqual([
      ['att', 'attachment:a1', 'said'],
      ['part', 'attachment:a1', 'translated'],
    ]);
    const [m] = messagesByIds(db, [id]);
    expect(m!.attachments[0]!.notes.map((n) => n.text)).toEqual(['said', 'translated']);
    expect(m!.embeds.map((e) => e.notes?.map((n) => n.text))).toEqual([['heard'], [], []]);
  });

  it('draw once when an embed shows one file as both its image and its thumbnail', () => {
    const shown = { imageUrl: STILL, thumbnailUrl: STILL, videoUrl: null } as ArchiveEmbed;
    expect(embedPartKeys(shown, 0)).toEqual(['embed-text:0', `embed:${STILL}`]);
  });
});

describe('derived text by part', () => {
  it('reads every plugin’s text that names its part, skipping empty and part-less ones', () => {
    const { db, id } = seeded();
    storeDerivedText(db, id, 'transcription:v', 1, 'こんにちは', undefined, `embed:${VIDEO}`);
    storeDerivedText(db, id, 'imagetext:1', 2, '', undefined, `embed:${STILL}`);
    storeDerivedText(db, id, 'old:1', 3, 'no part');
    expect(partTexts(db, [id])).toEqual([{ messageId: id, pluginId: 'transcription', part: `embed:${VIDEO}`, text: 'こんにちは' }]);
  });

  it('tags a plugin’s part-less texts by key, leaving tagged ones and other plugins’ alone', () => {
    const { db, id } = seeded();
    storeDerivedText(db, id, 'transcription:a1', 1, 'said');
    storeDerivedText(db, id, 'transcription:a2', 2, 'shown', undefined, 'attachment:a2');
    storeDerivedText(db, id, 'other:a1', 3, 'theirs');
    tagDerivedParts(db, 'transcription:', new Map([['a1', 'attachment:a1'], ['a2', 'attachment:wrong']]));
    expect(partTexts(db, [id]).map((t) => [t.pluginId, t.part])).toEqual([
      ['transcription', 'attachment:a1'],
      ['transcription', 'attachment:a2'],
    ]);
  });
});
