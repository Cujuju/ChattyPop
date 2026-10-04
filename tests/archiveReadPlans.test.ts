// Archive views stay readable by older SQLite, and archive reply reads use indexes and decode only what they need.
import { describe, expect, it } from 'vitest';
import { compressRawJson, type Db } from '../src/core/db';
import { installArchiveViews } from '../src/core/archiveViews';
import { archiveReplyExists, archiveReplyFlags } from '../src/core/plugins/archiveReplies';
import { textMessage } from '../src/core/queries/messageText';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb } from './helpers';
import { statementPlans } from './queryPlan';

/** Capture the production statement and inspect its actual bound query plan. */
function plan(db: Db, read: () => unknown): string[] {
  const details = statementPlans(db, read);
  expect(details.length).toBeGreaterThan(0);
  expect(details.join('\n')).not.toMatch(/MATERIALIZE|AUTOMATIC .*INDEX|SCAN (?:m\b|messages\b|archive_(?:all_)?(?:messages|names)\b)/i);
  return details;
}

describe('archive read plans and view compatibility', () => {
  it('replaces incompatible definitions already persisted by earlier builds', () => {
    const db = tempDb();
    seedArchiveViews(db);
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'archive_all_messages'").pluck().get() as string;
    db.exec('DROP VIEW archive_all_messages');
    db.exec(sql.replace('group_concat(text, char(10))', 'group_concat(text, char(10) ORDER BY text)'));
    installArchiveViews(db);
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'archive_all_messages'").pluck().get()).toBe(sql);
    expect(db.prepare("SELECT transcript FROM archive_all_messages WHERE id = 'm-open'").pluck().get()).toBe('first\nsecond');
  });
  it('keeps all persistent views and triggers free of aggregate ORDER BY, with ordered text intact', () => {
    const db = tempDb();
    seedArchiveViews(db);
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type IN ('view', 'trigger')").pluck().all() as string[];
    // Track parentheses so char(10) cannot hide aggregate-internal ORDER BY.
    for (const statement of sql) {
      for (const match of statement.matchAll(/\b(?:group_concat|json_group_array|json_group_object|string_agg)\s*\(/gi)) {
        let depth = 1;
        let end = match.index! + match[0].length;
        const start = end;
        while (depth && end < statement.length) {
          if (statement[end] === '(') depth++;
          if (statement[end] === ')') depth--;
          end++;
        }
        expect(statement.slice(start, end)).not.toMatch(/\bORDER\s+BY\b/i);
      }
    }
    expect(db.prepare("SELECT text, transcript FROM archive_all_messages WHERE id = 'm-open'").get())
      .toEqual({ text: 'hello open\nfirst\nsecond', transcript: 'first\nsecond' });
  });

  it('checks replies with indexed early exit and decodes only the requested flags, including compressed JSON', () => {
    const db = tempDb();
    seedArchiveViews(db);
    db.prepare("UPDATE messages SET author_id = 'u2', raw_json = ? WHERE id = 'm-ref-channel'")
      .run(compressRawJson(JSON.stringify({ type: 19, message_reference: { message_id: 'm-open' } })));
    const open = textMessage(db, 'm-open')!;
    plan(db, () => expect(archiveReplyExists(db, open.channelId, open.ts, open.authorId, open.id)).toBe(true));
    expect(archiveReplyExists(db, 'c-open', 1, 'u2', 'm-open')).toBe(false);
    plan(db, () => expect(archiveReplyFlags(db, ['m-ref-channel']).get('m-ref-channel')?.isReply).toBe(1));
    expect([...archiveReplyFlags(db, ['m-ref-channel']).keys()]).toEqual(['m-ref-channel']);
  });
});
