// Discord polls: a new poll checked as Discord would and sent in its message, the owner's vote round trip, and votes
// arriving over the gateway kept on the stored poll.
import { beforeEach, describe, expect, it } from 'vitest';
import type { OwnerMessage } from '@shared/compose';
import {
  POLL_ANSWER_MAX,
  POLL_ANSWERS_MAX,
  POLL_DURATION_HOURS_MAX,
  POLL_QUESTION_MAX,
  checkPollDraft,
  pollFrom,
  pollTimeLeft,
  type PollDraft,
  type RawPoll,
} from '@shared/polls';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import { applyGatewayEvent } from '../src/core/gatewayEvents';
import { messagesByIds } from '../src/core/queries/messages';
import type { DiscordApi } from '../src/main/discord/api';
import { votePollAsOwner } from '../src/main/discord/polls';
import { sendOwnerMessage } from '../src/main/discord/send';
import { rawMessage, seedArchive, tempDb } from './helpers';

const CHANNEL = '200000000000000001';
const MESSAGE = '300000000000000001';
const NONCE = '1300000000000000000';
const SELF = '100000000000000001';
const FRIEND = '100000000000000002';
const NOW = Date.UTC(2026, 9, 7);
const HOUR_MS = 3_600_000;

const draft = (d: Partial<PollDraft> = {}): PollDraft => ({ question: 'Lunch?', answers: ['Pizza', 'Tacos'], durationHours: 24, multiselect: false, ...d });

describe('a new poll', () => {
  it('is refused before any request for what Discord would refuse', () => {
    expect(() => checkPollDraft(draft({ question: '  ' }))).toThrow('Ask a question.');
    expect(() => checkPollDraft(draft({ question: 'x'.repeat(POLL_QUESTION_MAX + 1) }))).toThrow(`${POLL_QUESTION_MAX}`);
    expect(() => checkPollDraft(draft({ answers: [] }))).toThrow('answers');
    expect(() => checkPollDraft(draft({ answers: Array(POLL_ANSWERS_MAX + 1).fill('a') }))).toThrow('answers');
    expect(() => checkPollDraft(draft({ answers: ['Pizza', ' '] }))).toThrow('Fill in every answer');
    expect(() => checkPollDraft(draft({ answers: ['x'.repeat(POLL_ANSWER_MAX + 1)] }))).toThrow(`${POLL_ANSWER_MAX}`);
    expect(() => checkPollDraft(draft({ durationHours: POLL_DURATION_HOURS_MAX + 1 }))).toThrow('poll length');
    expect(() => checkPollDraft(draft({ durationHours: 0.5 }))).toThrow('poll length');
    expect(() => checkPollDraft({ question: 'q' })).toThrow('Not a poll.');
  });

  it('goes in its message as Discord’s client sends it, its text trimmed, with no text needed', async () => {
    const posts: [string, Record<string, unknown>][] = [];
    const api = {
      post: async (path: string, body: Record<string, unknown>) => {
        posts.push([path, body]);
        return { id: '1' };
      },
    } as unknown as DiscordApi;
    const message: OwnerMessage = { channelId: CHANNEL, text: '', replyTo: null, files: [], stickerId: null, gif: null, poll: draft({ question: ' Lunch? ', answers: [' Pizza', 'Tacos '], multiselect: true }), nonce: NONCE };
    await sendOwnerMessage(api, message);
    expect(posts[0]![0]).toBe(`channels/${CHANNEL}/messages`);
    expect(posts[0]![1]['poll']).toEqual({
      question: { text: 'Lunch?' },
      answers: [{ poll_media: { text: 'Pizza' } }, { poll_media: { text: 'Tacos' } }],
      duration: 24,
      allow_multiselect: true,
      layout_type: 1,
    });
  });

  it('refuses a bad poll in a message before any request', async () => {
    const api = { post: async () => expect.unreachable('posted') } as unknown as DiscordApi;
    const message = { channelId: CHANNEL, text: '', replyTo: null, files: [], stickerId: null, gif: null, poll: draft({ answers: [] }), nonce: NONCE };
    await expect(sendOwnerMessage(api, message)).rejects.toThrow('answers');
  });
});

describe('the owner’s vote', () => {
  const recorder = () => {
    const puts: [string, unknown][] = [];
    const api = { putJson: async (path: string, body: unknown) => void puts.push([path, body]) } as unknown as DiscordApi;
    return { api, puts };
  };

  it('PUTs every chosen answer, as the client does; none takes the vote back', async () => {
    const { api, puts } = recorder();
    await votePollAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, answerIds: [1, 3] });
    await votePollAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, answerIds: [] });
    expect(puts).toEqual([
      [`channels/${CHANNEL}/polls/${MESSAGE}/answers/@me`, { answer_ids: ['1', '3'] }],
      [`channels/${CHANNEL}/polls/${MESSAGE}/answers/@me`, { answer_ids: [] }],
    ]);
  });

  it('refuses what isn’t a vote before any request', async () => {
    const { api, puts } = recorder();
    for (const answerIds of [[0], [1.5], [1, 1], Array.from({ length: POLL_ANSWERS_MAX + 1 }, (_, i) => i + 1), 'x'])
      await expect(votePollAsOwner(api, { channelId: CHANNEL, messageId: MESSAGE, answerIds })).rejects.toThrow('Not a poll vote.');
    await expect(votePollAsOwner(api, { channelId: 'x', messageId: MESSAGE, answerIds: [1] })).rejects.toThrow();
    expect(puts).toEqual([]);
  });
});

describe('a stored poll', () => {
  let db: Db;
  let a: Archive;
  let changed: string[];
  const deps = { changed: (id: string) => changed.push(id), backfillFromMs: () => 0, selfId: () => SELF, dmActivity: () => undefined, autoArchiveSinceMs: () => null, optedIn: () => undefined };
  const RAW: RawPoll = {
    question: { text: 'Lunch?' },
    answers: [
      { answer_id: 1, poll_media: { text: 'Pizza', emoji: { id: null, name: '🍕' } } },
      { answer_id: 2, poll_media: { text: 'Tacos' } },
    ],
    expiry: new Date(NOW + HOUR_MS).toISOString(),
    allow_multiselect: false,
  };
  const poll = (id: string) => messagesByIds(db, [id])[0]!.poll!;
  const votes = (id: string) => poll(id).answers.map((x) => [x.id, x.votes, x.mine]);
  const vote = (t: 'MESSAGE_POLL_VOTE_ADD' | 'MESSAGE_POLL_VOTE_REMOVE', id: string, userId: string, answer: number) =>
    applyGatewayEvent(a, t, { channel_id: CHANNEL, message_id: id, answer_id: answer, user_id: userId }, deps);

  beforeEach(() => {
    db = tempDb();
    a = seedArchive(db, [{ id: CHANNEL }]);
    changed = [];
  });

  it('reads as the Archive shows it', () => {
    const m = rawMessage(CHANNEL, NOW, '', { poll: RAW });
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    expect(poll(m.id)).toEqual({
      question: 'Lunch?',
      answers: [
        { id: 1, text: 'Pizza', emoji: { id: null, name: '🍕', animated: false }, votes: 0, mine: false },
        { id: 2, text: 'Tacos', emoji: null, votes: 0, mine: false },
      ],
      multiselect: false,
      expiresAt: NOW + HOUR_MS,
      finalized: false,
    });
    expect(messagesByIds(db, [applyAndId(rawMessage(CHANNEL, NOW + 1, 'plain'))])[0]!.poll).toBeNull();
  });

  function applyAndId(m: ReturnType<typeof rawMessage>): string {
    applyGatewayEvent(a, 'MESSAGE_CREATE', m, deps);
    return m.id;
  }

  it('counts everyone’s votes from the gateway and marks the owner’s own', () => {
    const id = applyAndId(rawMessage(CHANNEL, NOW, '', { poll: RAW }));
    vote('MESSAGE_POLL_VOTE_ADD', id, FRIEND, 2);
    vote('MESSAGE_POLL_VOTE_ADD', id, SELF, 2);
    expect(votes(id)).toEqual([[1, 0, false], [2, 2, true]]);
    vote('MESSAGE_POLL_VOTE_REMOVE', id, SELF, 2);
    expect(votes(id)).toEqual([[1, 0, false], [2, 1, false]]);
    expect(changed.filter((c) => c === CHANNEL)).toHaveLength(4);
  });

  it('the owner’s vote applied first, then its gateway echo, counts once; a changed vote moves it', () => {
    const id = applyAndId(rawMessage(CHANNEL, NOW, '', { poll: RAW }));
    expect(a.applyOwnPollVote({ channelId: CHANNEL, messageId: id, answerIds: [1] })).toBe(true);
    changed = [];
    vote('MESSAGE_POLL_VOTE_ADD', id, SELF, 1);
    expect(votes(id)).toEqual([[1, 1, true], [2, 0, false]]);
    expect(changed).toEqual([]);
    a.applyOwnPollVote({ channelId: CHANNEL, messageId: id, answerIds: [2] });
    vote('MESSAGE_POLL_VOTE_REMOVE', id, SELF, 1);
    vote('MESSAGE_POLL_VOTE_ADD', id, SELF, 2);
    expect(votes(id)).toEqual([[1, 0, false], [2, 1, true]]);
  });

  it('a message without a poll takes no votes', () => {
    const id = applyAndId(rawMessage(CHANNEL, NOW, 'plain'));
    vote('MESSAGE_POLL_VOTE_ADD', id, FRIEND, 1);
    expect(changed).toEqual([CHANNEL]);
  });

  it('reads an unknown shape as no poll, and Discord’s results as given', () => {
    expect(pollFrom(null)).toBeNull();
    expect(pollFrom({ question: { text: 'q' } })).toBeNull();
    const ended = pollFrom({ ...RAW, expiry: null, results: { is_finalized: true, answer_counts: [{ id: 1, count: 3, me_voted: true }] } })!;
    expect(ended).toMatchObject({ expiresAt: null, finalized: true });
    expect(ended.answers[0]).toMatchObject({ votes: 3, mine: true });
  });
});

describe('time left', () => {
  it('words it as Discord does, and nothing once ended', () => {
    expect(pollTimeLeft(NOW + 3 * 24 * HOUR_MS + 1, NOW)).toBe('3d left');
    expect(pollTimeLeft(NOW + 5 * HOUR_MS, NOW)).toBe('5h left');
    expect(pollTimeLeft(NOW + 30_000, NOW)).toBe('1m left');
    expect(pollTimeLeft(NOW, NOW)).toBeNull();
  });
});
