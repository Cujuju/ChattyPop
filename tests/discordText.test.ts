import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { cutOutsideTokens, plainDiscordText } from '@shared/discordText';
import { snippet } from '../src/core/queries/snippet';
import type { Db } from '../src/core/db';
import { trimCutSnippetTokens } from '../src/core/laterMigrations';

const EMOJI = '<:test_emoji:100000000000000001>';
const USER = '123456789012345678';
const CHANNEL = '223456789012345678';

describe('Discord text in snippets', () => {
  it('writes tokens as words', () => {
    const text = `hi <@${USER}> in <#${CHANNEL}> ${EMOJI} <@&323456789012345678> <a:wave:100000000000000002>`;
    expect(plainDiscordText(text, { users: { [USER]: 'Tony' }, channel: (id) => (id === CHANNEL ? 'general' : undefined) })).toBe('hi @Tony in #general :test_emoji: @role :wave:');
    expect(plainDiscordText(`<@${USER}> <#${CHANNEL}>`)).toBe('@unknown-user #unknown-channel');
    expect(plainDiscordText('<t:0:R>')).toBe(new Date(0).toLocaleString());
  });

  it('moves a cut out of a token, back to its start or past its end', () => {
    const text = `ab ${EMOJI} cd`;
    const inside = 3 + 5;
    expect(cutOutsideTokens(text, inside, false)).toBe(3);
    expect(cutOutsideTokens(text, inside, true)).toBe(3 + EMOJI.length);
    expect(cutOutsideTokens(text, 1, true)).toBe(1);
  });

  it('keeps tokens whole at both ends of a snippet', () => {
    const long = `${'x'.repeat(100)} ${EMOJI} ${'y'.repeat(100)} target ${'z'.repeat(40)} <@${USER}> ${'w'.repeat(200)}`;
    for (const max of [30, 60, 90, 120, 160, 200]) {
      const s = snippet(long, /target/, max);
      const bare = s.replace(/^…|…$/g, '');
      expect(bare).not.toMatch(/<[^>]*$/); // no token cut at the end
      expect(bare).not.toMatch(/^[^<]*>/); // nor at the start
    }
    expect(snippet(`${EMOJI} tail`, null, 5)).toBe(`${EMOJI}…`);
  });

  it('repairs snippets stored with a token cut at either end', () => {
    const db = new Database(':memory:') as unknown as Db;
    db.exec('CREATE TABLE alerts (id INTEGER PRIMARY KEY, snippet TEXT NOT NULL)');
    const rows = ['…emoji:100000000000000001> nice', 'look <:test_emo…', 'a > b and <b>', `whole ${EMOJI}`];
    for (const s of rows) db.prepare('INSERT INTO alerts (snippet) VALUES (?)').run(s);
    trimCutSnippetTokens(db);
    expect(db.prepare('SELECT snippet FROM alerts ORDER BY id').pluck().all()).toEqual(['… nice', 'look …', 'a > b and <b>', `whole ${EMOJI}`]);
  });
});
