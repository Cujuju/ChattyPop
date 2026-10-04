// Transcripts as message text beyond topics and search: plugins and text retention.
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { DEFAULT_ARCHIVE_SETTINGS } from '@shared/settings';
import { VOICE_MESSAGE_FLAG } from '@shared/discord';
import { MS_PER_DAY } from '@shared/units';
import type { Db } from '../src/core/db';
import { createPluginApi, emptyRegistrations } from '../src/core/plugins/api';
import { applyTextRetention } from '../src/core/textRetention';
import { storeDerivedText } from '../src/core/derivedText';
import { registerTextCoverage } from '../src/core/textCoverage';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';

const CH = '200000000000000001';

let db: Db;
let voiceId: string;
beforeEach(() => {
  db = tempDb();
  const a = seedArchive(db, [{ id: CH }]);
  const t0 = Date.now() - MS_PER_DAY;
  const voice = rawMessage(CH, t0 + 1000, '', {
    flags: VOICE_MESSAGE_FLAG,
    attachments: [{ id: 'a1', filename: 'voice-message.ogg', content_type: 'audio/ogg', url: 'https://cdn.example/a1' }],
  });
  voiceId = voice.id;
  a.ingestMessages([rawMessage(CH, t0, 'who is bringing snacks?'), voice], ARRIVAL.gateway);
});

/** The transcription plugin settled a transcript: the host keeps it as the message's derived text. */
const transcribe = (text: string): void => storeDerivedText(db, voiceId, 'transcription:a1', 1, text);

describe('plugins', () => {
  it('query.messages returns a voice message with its transcript', () => {
    transcribe('I will bring chips');
    const api = createPluginApi('p', { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null }, emptyRegistrations(), () => undefined);
    expect(api.query.messages({}).find((m) => m.id === voiceId)?.content).toBe('I will bring chips');
  });
});

describe('text retention', () => {
  it('summary-only keeps transcripts when it removes the message text', async () => {
    transcribe('I will bring chips');
    const now = Date.now() + 200 * MS_PER_DAY;
    // An owner (e.g. a summary) covering the whole channel up to now.
    onTestFinished(registerTextCoverage(() => [{ channelIds: [CH], since: 0, until: now }]));
    const r = await applyTextRetention(db, { ...DEFAULT_ARCHIVE_SETTINGS, textTier: 'summary-only', textTierAfterDays: 90 }, now);
    expect(r.pruned).toBeGreaterThan(0);
    expect(db.prepare('SELECT text FROM derived_texts WHERE message_id = ?').pluck().get(voiceId)).toBe('I will bring chips');
  });
});
