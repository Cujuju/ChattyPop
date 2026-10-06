// Transcripts as host derived text (search, rules) and attachment notes, and main's atomic download of a job's audio.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from 'electron';
import { AttachmentDownloader } from '../src/main/media/attachmentDownloader';
import type { DiscordApi } from '../src/main/discord/api';
import type { CoreClient } from '../src/main/coreClient';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { VOICE_MESSAGE_FLAG } from '@shared/discord';
import { registerAttachmentNotes, unregisterAttachmentNotes } from '../src/core/attachmentNotes';
import { storeDerivedText } from '../src/core/derivedText';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { messagePage } from '../src/core/queries/messages';
import { addedTextArrival, textMessage } from '../src/core/queries/messageText';
import { searchMessages } from '../src/core/queries/search';
import { ARRIVAL } from '../src/core/arrival';
import { nextTs, rawMessage, seedArchive, settleAsync, tempDb, tempDir } from './helpers';
import { probeRule, ruleHarness } from './ruleHarness';

/** Older than any rule a test creates: a match on it is history. */
const LAST_YEAR = Date.UTC(2025, 0, 1);
/** The note provider standing in for a transcriber. */
const NOTES_PLUGIN = 'notesprobe';

/** A voice message with one audio attachment in channel c1. */
function voiceMessage(archive: Archive, o: { ts?: number; content?: string } = {}): { messageId: string; attachmentId: string } {
  const attachmentId = `a-${nextTs()}`;
  const m = rawMessage('c1', o.ts ?? nextTs(), o.content ?? '', {
    flags: VOICE_MESSAGE_FLAG,
    attachments: [{ id: attachmentId, filename: 'voice-message.ogg', content_type: 'audio/ogg', url: 'https://cdn.example/a' }],
  });
  archive.ingestMessages([m], ARRIVAL.gateway);
  return { messageId: m.id, attachmentId };
}

/** A transcriber settled `text`: the host keeps it as the message's derived text, as core wires a plugin's text. */
const transcribe = (db: Db, v: { messageId: string; attachmentId: string }, text: string): void =>
  storeDerivedText(db, v.messageId, `${NOTES_PLUGIN}:${v.attachmentId}`, 1, text);

describe('transcripts reach search, rules and the Archive', () => {
  it('search finds spoken words, listing a message once', () => {
    const db = tempDb();
    const v = voiceMessage(seedArchive(db, [{ id: 'c1' }]), { content: 'lighthouse plans' });
    transcribe(db, v, 'meet at the lighthouse');
    expect(searchMessages(db, 'lighthouse', 10, 'relevance').map((h) => h.messageId)).toEqual([v.messageId]);
    expect(searchMessages(db, 'meet', 10, 'relevance').map((h) => h.messageId)).toEqual([v.messageId]);
  });

  it('a rule matches a transcript of a message older than the rule, as history', async () => {
    const h = ruleHarness();
    const id = h.rules.create(probeRule({ text: { pattern: 'boat', spec: null } }, { name: 'boat' }));
    const v = voiceMessage(h.archive, { ts: LAST_YEAR });
    const matched = () => h.probe.runs.filter((r) => r.rule.id === id).map((r) => [r.history, r.event.kind === 'message' && r.event.m.id]);
    expect(matched()).toEqual([]);
    transcribe(h.db, v, 'the boat leaves at noon');
    h.matcher.check(textMessage(h.db, v.messageId)!, addedTextArrival(h.db, v.messageId, Date.now()));
    await settleAsync();
    expect(matched()).toEqual([[true, v.messageId]]);
  });

  it("the Archive shows a plugin's note on its attachment", () => {
    const db = tempDb();
    const v = voiceMessage(seedArchive(db, [{ id: 'c1' }]));
    const note = { kind: 'transcript', state: 'done', label: 'transcript · en', text: 'see you soon' } as const;
    registerAttachmentNotes(NOTES_PLUGIN, 0, (ids) => new Map(ids.filter((a) => a === v.attachmentId).map((a) => [a, note])));
    onTestFinished(() => unregisterAttachmentNotes(NOTES_PLUGIN));
    const [m] = messagePage(db, { channelId: 'c1', limit: 10 });
    expect(m?.attachments[0]?.notes).toEqual([{ pluginId: NOTES_PLUGIN, part: `attachment:${v.attachmentId}`, ...note }]);
  });
});

describe("main's download of a job's audio", () => {
  it('appears at the requested path only once complete, so a job never reads a partial file', async () => {
    const encode = (t: string) => new TextEncoder().encode(t);
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(encode('part'));
        finish = () => (c.enqueue(encode('-rest')), c.close());
      },
    });
    const ses = { fetch: async () => new Response(body) } as unknown as Session;
    const unused = {} as DiscordApi & CoreClient;
    const downloader = new AttachmentDownloader(tempDir(), tempDir(), ses, unused, unused, async () => ({ mediaMs: 0, jitter: 0 }) as never, async () => true, { kept: () => true, keep: async () => null });
    const dir = tempDir();
    const path = join(dir, 'a.audio');
    const done = downloader.fetchTo({ attachmentId: 'a', messageId: 'm', channelId: 'c', url: 'https://cdn.example/a', path });
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1)); // still downloading
    expect(existsSync(path)).toBe(false);
    finish();
    await expect(done).resolves.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('part-rest');
    expect(readdirSync(dir)).toEqual(['a.audio']);
  });
});
