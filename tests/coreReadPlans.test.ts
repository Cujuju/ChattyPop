import { expect, it } from 'vitest';
import { directory } from '../src/core/queries/directory';
import { messagePage } from '../src/core/queries/messages';
import { readHost } from '../src/core/reads/archiveReads';
import { JUDGE_BATCH } from '../src/core/conversations/judgeJob';
import { unjudged } from '../src/core/conversations/unjudged';
import { seedPerfArchive, TEST_ARCHIVE } from './perfArchiveFixture';
import { statementPlans } from './queryPlan';
import { tempDb } from './helpers';
import { hideSome } from './perfArchiveFixture';
import { privacy, readPrivacy } from '../src/core/queries/privacy';
import { archiveRead } from '../src/core/plugins/pluginDb';

/** A normal chat page must seek the channel and hydrate only its displayed rows. */
const MESSAGE_PAGE_SIZE = 50;

it('keeps synchronous message pages indexed at archive scale', () => {
  const db = tempDb();
  const { channels } = seedPerfArchive(db, TEST_ARCHIVE);
  const details = statementPlans(db, () => {
    expect(messagePage(db, { channelId: channels[0]!, limit: MESSAGE_PAGE_SIZE }).length).toBeLessThanOrEqual(MESSAGE_PAGE_SIZE);
  });
  expect(details.join('\n')).toMatch(/SEARCH m .*channel_id=\?/);
  expect(details.join('\n')).not.toMatch(/\bSCAN (?:m|messages)\b/);
});

it('runs exact directory counts off-thread with the caller’s notable condition', async () => {
  const db = tempDb();
  seedPerfArchive(db, TEST_ARCHIVE);
  const { id } = db.prepare('SELECT id FROM messages LIMIT 1').get() as { id: string };
  db.prepare(`INSERT INTO jev_judgments(message_id, subject, value, label, model, judged_at)
    VALUES (?, 'notable', 1, 'custom', 'fixture', 0)`).run(id);
  const notable = { sql: 'j.label = @notable_choice', params: { notable_choice: 'custom' } };
  const expected = directory(db, 0, null, null, notable);
  expect(expected.flatMap((g) => g.channels).reduce((n, c) => n + c.notableCount, 0)).toBe(1);
  expect(await readHost(db, { kind: 'directory', unseen: 0, self: null, reader: null, notable }, undefined, 'interactive')).toEqual(expected);
});

it('seeks newest judge candidates and returns the same background snapshot', async () => {
  const db = tempDb();
  seedPerfArchive(db, TEST_ARCHIVE);
  db.prepare(`INSERT INTO conversation_links(message_id, channel_id, ts, parent_id, kind, confidence)
    SELECT id, channel_id, ts, NULL, 'inferred', 0 FROM messages`).run();
  const now = (db.prepare('SELECT MAX(ts) AS ts FROM messages').get() as { ts: number }).ts;
  let expected: ReturnType<typeof unjudged> = [];
  const details = statementPlans(db, () => { expected = unjudged(db, now, JUDGE_BATCH); });
  expect(details.join('\n')).toContain('SEARCH l USING INDEX conversation_links_kind_ts (kind=? AND ts>?)');
  expect(details.join('\n')).not.toMatch(/\bSCAN l\b|USE TEMP B-TREE FOR ORDER BY/);
  expect(expected).toHaveLength(JUDGE_BATCH);
  expect(await readHost(db, { kind: 'unjudged', now, limit: JUDGE_BATCH }, undefined, 'background')).toEqual(expected);
});

it('keeps asynchronous privacy scope and name redaction identical', async () => {
  const db = tempDb();
  const fixture = seedPerfArchive(db, TEST_ARCHIVE);
  hideSome(db, fixture);
  const before = privacy(db);
  const after = await readPrivacy(archiveRead(() => db));
  expect(after.active).toBe(before.active);
  expect(after.hiddenChannels).toEqual(before.hiddenChannels);
  const names = db.prepare('SELECT name FROM channels UNION ALL SELECT name FROM guilds').pluck().all() as string[];
  for (const name of names) expect(after.redact(`A name: #${name}.`)).toBe(before.redact(`A name: #${name}.`));
});
