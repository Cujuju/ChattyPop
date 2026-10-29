// Contract tests for privacy.
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEYS } from '@shared/settings';
import { MS_PER_MIN, MS_PER_S } from '@shared/units';
import type { Archive } from '../src/core/archive';
import { setSetting, type Db } from '../src/core/db';
import { directory } from '../src/core/queries/directory';
import { messagePage, messagesByIds } from '../src/core/queries/messages';
import { privacyScope } from '../src/core/queries/privacy';
import { searchMessages } from '../src/core/queries/search';
import { privacyCss } from '../src/main/discord/privacyCss';
import { rawMessage, seedArchive, tempDb } from './helpers';
import { ARRIVAL } from '../src/core/arrival';
import { archiveReplyTargets } from '../src/core/plugins/archiveReplies';
import { askRange } from '../src/core/jev/askRange';
import { MessageJudge } from '../src/core/jev/messageJudge';
import { customQuestion } from '../src/core/jev/questions';
import { textMessage } from '../src/core/queries/messageText';
import { FakeJev } from './fakeJev';

const OPEN_GUILD = { id: '100000000000000001', name: 'Open Server' };
const SECRET_GUILD = { id: '100000000000000002', name: 'Secret Server' };
const GENERAL = '200000000000000001';
const MODS = '200000000000000002';
const MODS_THREAD = '300000000000000001';
const SECRET_CHANNEL = '200000000000000003';

let db: Db;
let archive: Archive;
const setMode = (on: boolean): void => setSetting(db, SETTINGS_KEYS.privacyMode, on);
const at = (n: number): number => Date.now() - MS_PER_MIN + n * MS_PER_S;
/** Shared links the archive shows, in first-share order. */
const shownLinks = (): unknown[] => db.prepare('SELECT url FROM archive_links ORDER BY first_ts, id').pluck().all();

beforeEach(() => {
  db = tempDb();
  archive = seedArchive(
    db,
    [
      { id: GENERAL, name: 'general', guildId: OPEN_GUILD.id },
      { id: MODS, name: 'mod-chat', guildId: OPEN_GUILD.id },
      { id: SECRET_CHANNEL, name: 'lobby', guildId: SECRET_GUILD.id },
    ],
    { guilds: [OPEN_GUILD, SECRET_GUILD] },
  );
  archive.upsertThreads([{ id: MODS_THREAD, name: 'side talk', type: 11, parent_id: MODS, last_message_id: null }], 0);
  archive.setChannelPolicy(MODS, { hideInPrivacy: true });
  archive.setGuildHideInPrivacy(SECRET_GUILD.id, true);
});

describe('privacy scope', () => {
  it('hides nothing while privacy mode is off', () => {
    expect(privacyScope(db)).toEqual({ guildIds: [], channelIds: [] });
    const dir = directory(db, 0);
    expect(dir.find((g) => g.id === SECRET_GUILD.id)?.hideInPrivacy).toBe(true);
    expect(dir.flatMap((g) => g.channels).find((c) => c.id === MODS)?.hideInPrivacy).toBe(true);
  });

  it('hides marked channels with their threads, and marked servers with all their channels', () => {
    setMode(true);
    const scope = privacyScope(db);
    expect(scope.guildIds).toEqual([SECRET_GUILD.id]);
    expect(new Set(scope.channelIds)).toEqual(new Set([MODS, MODS_THREAD, SECRET_CHANNEL]));
    const dir = directory(db, 0);
    expect(dir.map((g) => g.id)).not.toContain(SECRET_GUILD.id);
    expect(dir.flatMap((g) => g.channels).map((c) => c.id)).toEqual([GENERAL]);
  });

  it('refuses to mark a server that is not a snowflake (its id is matched inside message text)', () => {
    expect(() => archive.setGuildHideInPrivacy('@me', true)).toThrow();
  });
});

describe('messages in privacy mode', () => {
  beforeEach(() => {
    archive.ingestMessages([
      rawMessage(GENERAL, at(1), 'plain hello'),
      rawMessage(GENERAL, at(2), `see <#${MODS}> hello`),
      rawMessage(GENERAL, at(3), `hello https://discord.com/channels/${SECRET_GUILD.id}/${SECRET_CHANNEL}/1`),
      rawMessage(GENERAL, at(4), 'hello https://example.com/shared'),
      rawMessage(MODS, at(5), 'hello from mods https://example.com/mods'),
    ], ARRIVAL.gateway);
  });

  it('shows everything while off', () => {
    expect(messagePage(db, { channelId: GENERAL, limit: 10 })).toHaveLength(4);
    expect(searchMessages(db, 'hello', 10, 'relevance')).toHaveLength(5);
    expect(shownLinks()).toEqual(['https://example.com/shared', 'https://example.com/mods']); // Discord's own links aren't listed
  });

  it('drops hidden channels and any message naming one by id', () => {
    setMode(true);
    expect(messagePage(db, { channelId: GENERAL, limit: 10 }).map((m) => m.content)).toEqual(['plain hello', 'hello https://example.com/shared']);
    expect(messagePage(db, { channelId: MODS, limit: 10 })).toEqual([]);
    expect(searchMessages(db, 'hello', 10, 'relevance').map((h) => h.channelId)).toEqual([GENERAL, GENERAL]);
    // A link first shared in a hidden channel is gone too.
    expect(shownLinks()).toEqual(['https://example.com/shared']);
  });

  it('looks a message up by id (the alert menu) only while it is shown', () => {
    const [mods] = messagePage(db, { channelId: MODS, limit: 10 });
    expect(messagesByIds(db, [mods!.id]).map((m) => m.content)).toEqual(['hello from mods https://example.com/mods']);
    setMode(true);
    expect(messagesByIds(db, [mods!.id])).toEqual([]);
  });

  it("leaves out a shown reply's preview of a hidden source, archived or only in Discord's snapshot", () => {
    const [plain, naming] = messagePage(db, { channelId: GENERAL, limit: 10 });
    const snapshot = (id: string, content: string, channelId = GENERAL) => ({ id, channel_id: channelId, content, author: { id: 'u2', username: 'bob' } });
    const replyTo = (n: number, ref: ReturnType<typeof snapshot>) =>
      rawMessage(GENERAL, at(10 + n), `reply ${n}`, { type: 19, message_reference: { message_id: ref.id }, referenced_message: ref } as never);
    const replies = [
      replyTo(1, snapshot(plain!.id, plain!.content)),
      replyTo(2, snapshot(naming!.id, naming!.content)), // archived source naming a hidden channel
      replyTo(3, snapshot('400000000000000001', `ask <#${MODS}>`)), // snapshot only, naming a hidden channel
      replyTo(4, snapshot('400000000000000002', 'from the hidden server', SECRET_CHANNEL)), // snapshot only, in a hidden channel
    ];
    archive.ingestMessages(replies, ARRIVAL.gateway);
    const previews = (): (string | null)[] => messagesByIds(db, replies.map((r) => r.id)).map((m) => m.reply?.content ?? null);
    expect(previews()).toEqual(['plain hello', `see <#${MODS}> hello`, `ask <#${MODS}>`, 'from the hidden server']);
    setMode(true);
    expect(previews()).toEqual(['plain hello', null, null, null]);
  });
});

describe('reply targets and Jev context in privacy mode (#252)', () => {
  const reply = (channelId: string, n: number, target: ReturnType<typeof rawMessage>) =>
    rawMessage(channelId, at(n), `reply ${n}`, { type: 19, message_reference: { message_id: target.id }, referenced_message: target } as never);
  const naming = rawMessage(GENERAL, at(1), `ask in <#${MODS}>`, { author: { id: 'u2', username: 'bob' } });
  const earlier = rawMessage(GENERAL, at(2), `see https://discord.com/channels/${SECRET_GUILD.id}/${SECRET_CHANNEL}/1`);
  const shown = reply(GENERAL, 3, naming);
  const inMods = rawMessage(MODS, at(4), 'mods only question');
  const hidden = reply(MODS, 5, inMods);
  beforeEach(() => archive.ingestMessages([naming, earlier, shown, inMods, hidden], ARRIVAL.gateway));

  it("withholds a hidden target's text from a shown reply, never from a reply privacy mode hides too", () => {
    const targets = () => Object.fromEntries(archiveReplyTargets(db, [shown.id, hidden.id]));
    expect(targets()[shown.id]).toEqual({ id: naming.id, authorId: 'u2', author: 'bob', content: `ask in <#${MODS}>` });
    setMode(true);
    expect(targets()).toEqual({
      [shown.id]: { id: naming.id, authorId: 'u2', author: 'bob', content: '' },
      [hidden.id]: { id: inMods.id, authorId: 'u1', author: 'Alice', content: 'mods only question' },
    });
  });

  it('a Jev request about a shown message carries no text privacy mode hides', async () => {
    setMode(true);
    const jev = new FakeJev();
    const ask = (id: string) => new MessageJudge(db).decideAbout(jev, textMessage(db, id)!, { q: customQuestion({ type: 'noul', question: 'Is `message` a question?', yes: '', no: '' }) });
    await ask(shown.id);
    expect(JSON.stringify(jev.requests[0]!.state)).not.toMatch(new RegExp(`${MODS}|${SECRET_GUILD.id}`));
    await ask(hidden.id);
    expect(JSON.stringify(jev.requests[1]!.state)).toContain('mods only question');
  });

  it("Jev's ranking of a shown channel returns and sends no text privacy mode hides; of a hidden one, its own", async () => {
    setMode(true);
    const jev = new FakeJev();
    jev.values = { ask: 0.5 };
    const rank = (channelId: string) =>
      askRange(db, new MessageJudge(db), jev, { channelId, question: { type: 'noul', question: 'Is `message` a question?', yes: '', no: '' }, limit: 10 });
    const general = await rank(GENERAL);
    expect(general.results.map((r) => r.content)).toEqual(['reply 3']);
    expect(JSON.stringify(jev.requests.map((q) => q.state))).not.toMatch(new RegExp(`${MODS}|${SECRET_GUILD.id}`));
    const mods = await rank(MODS);
    expect(mods.results.map((r) => r.content).sort()).toEqual(['mods only question', 'reply 5']);
  });
});

describe('privacy css for the live client', () => {
  it('is empty when nothing is hidden', () => {
    expect(privacyCss({ guildIds: [], channelIds: [] })).toBe('');
  });

  it('hides server rail entries, channel rows and rows linking to hidden ids; non-snowflakes never reach a selector', () => {
    const css = privacyCss({ guildIds: [SECRET_GUILD.id, '"]{}'], channelIds: [MODS] });
    expect(css).toContain(`[data-list-item-id="guildsnav___${SECRET_GUILD.id}"]`);
    expect(css).toContain(`img[src*="/icons/${SECRET_GUILD.id}/"]`);
    expect(css).toContain(`li:has([data-list-item-id="channels___${MODS}"])`);
    expect(css).toContain(`li:has(a[href$="/${MODS}"])`);
    expect(css).toContain(`li:has(a[href*="/${MODS}/"])`);
    expect(css).not.toContain('"]{}');
    expect(css.endsWith('{ display: none !important; }')).toBe(true);
  });
});
