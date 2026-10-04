import { beforeEach, describe, expect, it } from 'vitest';
import { contentSummary, type ContentKind } from '@shared/messageContent';
import { VOICE_MESSAGE_FLAG } from '@shared/discord';
import type { RuleInput } from '@shared/rules';
import type { Db } from '../src/core/db';
import { contentReader } from '../src/core/queries/messageContent';
import { previewPattern } from '../src/core/patternPreview';
import { ARRIVAL } from '../src/core/arrival';
import { from, rawMessage } from './helpers';
import { probeRule, ruleHarness, runsOf, type Harness } from './ruleHarness';

/** The probe action's kind, which keeps history. */
const PROBE_ACTION = 'ruleprobe.instant';
/** How long before the rule a past message was sent. */
const PAST_MS = 1000;

let h: Harness;
let db: Db;
beforeEach(() => {
  h = ruleHarness();
  db = h.db;
});

const say = (content: string, extra: Record<string, unknown> = {}) => h.say(content, { extra });
let fileSeq = 0;
const file = (id: string, contentType: string, filename = 'f') => ({
  id,
  filename,
  content_type: contentType,
  url: `https://cdn.example/${id}`,
});
const voice = () =>
  say('', { flags: VOICE_MESSAGE_FLAG, attachments: [file(`v${++fileSeq}`, 'audio/ogg', 'voice-message.ogg')] });
const image = (content = '') => say(content, { attachments: [file(`i${++fileSeq}`, 'image/png')] });
const rule = (contains: ContentKind[] | null, pattern = ''): RuleInput =>
  probeRule(pattern ? { text: { pattern, spec: null } } : {}, { narrow: contains ? { contains } : {} });
/** The messages the rule ran on, oldest first. */
const matched = (ruleId: number) => runsOf(h, ruleId).map((r) => r[0]);
/** The rule's archive history for its probe action: [message id, older than the rule]. */
const history = (ruleId: number) => {
  const read = h.engine.kinds.history(PROBE_ACTION, ruleId)!;
  return read.matches().map(({ m }) => [m.id, m.ts < read.armedAt]);
};
const kinds = (messageId: string) => [...contentReader(db)(messageId)].sort();

describe('what a message carries', () => {
  it('reads attachments, links, voice, stickers, polls and forwards', () => {
    const v = voice();
    const pic = image('see https://youtu.be/abc and https://example.com');
    const sticker = say('', { sticker_items: [{ id: 's1', name: 'x', format_type: 1 }] });
    const poll = say('', { poll: { question: { text: 'lunch?' }, answers: [] } });
    const fwd = say('', { message_snapshots: [{ message: { content: 'hi' } }] });
    expect(kinds(v.id)).toEqual(['audio', 'file', 'voice']);
    expect(kinds(pic.id)).toEqual(['file', 'image', 'link', 'mediaLink']);
    expect([kinds(sticker.id), kinds(poll.id), kinds(fwd.id)]).toEqual([['sticker'], ['poll'], ['forward']]);
    expect(kinds(say('plain').id)).toEqual([]);
  });

  it('summarises by the most specific kinds', () => {
    expect(contentSummary(contentReader(db)(voice().id))).toBe('[Voice message]');
    expect(contentSummary(new Set<ContentKind>(['image', 'file', 'link']))).toBe('[Image, Link]');
    expect(contentSummary(new Set())).toBe('');
  });
});

describe('a rule by what messages contain', () => {
  it('matches on the narrowing alone, including messages with no text', () => {
    const id = h.rules.create(rule(['voice']));
    const v = voice();
    image();
    say('just text');
    expect(matched(id)).toEqual([v.id]);
  });

  it('with keywords, needs both', () => {
    const id = h.rules.create(rule(['image'], 'cat'));
    const both = image('a cat');
    image('a dog');
    say('a cat, no picture');
    expect(matched(id)).toEqual([both.id]);
  });

  it('finds past matches when created, read, and drops them when the narrowing changes', () => {
    const past = rawMessage('c1', Date.now() - PAST_MS, '', { ...from('u2'), attachments: [file('old', 'image/png')] });
    h.archive.ingestMessages([past], ARRIVAL.gateway);
    const id = h.rules.create(rule(['image', 'video']));
    expect(history(id)).toEqual([[past.id, true]]);
    h.rules.update(id, rule(['voice']));
    expect(history(id)).toEqual([]);
    expect(h.engine.kinds.history(PROBE_ACTION, id)!.syncDirect).toBe(true); // an owner drops the old matches it kept
  });

  it('stores the narrowing with the rule, and rejects an unknown kind', () => {
    const id = h.rules.create(rule(['mediaLink', 'poll']));
    expect(
      h.rules
        .list()
        .find((r) => r.id === id)!
        .spec.narrow.find((p) => p.type === 'contains')?.config,
    ).toEqual(['mediaLink', 'poll']);
    expect(() => h.rules.create(rule(['nope' as ContentKind]))).toThrow(/Pick what the messages contain again/);
  });

  it("the editor's check applies Contains too", () => {
    const both = image('a cat');
    say('a cat, no picture');
    expect(previewPattern(db, 'cat', null, ['image']).hits.map((h) => h.messageId)).toEqual([both.id]);
    expect(previewPattern(db, 'cat', null, null).matched).toBe(2);
  });

  it('a regex never matches a message with no text', () => {
    const id = h.rules.create(rule(null, '/.*/'));
    image();
    const t = say('words');
    expect(matched(id)).toEqual([t.id]);
  });
});
