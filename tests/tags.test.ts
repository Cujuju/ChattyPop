// Host Jev auto-labels, independent of the owner Tags plugin.
import { describe, expect, it } from 'vitest';
import { messageQuestions } from '../src/core/jev/messageQuestions';
import { jevQuery } from '../src/core/jev/queries';
import { TAG_QUERY, TAG_SUBJECT, registerTags } from '../src/core/jev/tags';
import { messagePage } from '../src/core/queries/messages';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

/** The tags query's default threshold. */
const TAG_AT = (jevQuery(TAG_QUERY) as { minProbability: number }).minProbability;

describe('message tags', () => {
  it('registers one choice question behind the messageTags toggle', () => {
    registerTags();
    const q = messageQuestions().find((x) => x.subject === TAG_SUBJECT)!;
    expect(q.feature).toBe('messageTags');
    expect(
      q.question(
        { id: 'm', channelId: 'c', authorId: 'a', ts: 1, content: 'x', linked: '' },
        { live: true, edit: false, mayAct: () => false },
      )?.type,
    ).toBe('choice');
  });

  it('shows a tag only when Jev is fairly sure, and never "none"', () => {
    const db = tempDb();
    const a = seedArchive(db, [{ id: 'c' }]);
    const t0 = Date.UTC(2026, 8, 1);
    const [sure, unsure, none] = [
      rawMessage('c', t0, 'we ship friday'),
      rawMessage('c', t0 + 1, 'maybe'),
      rawMessage('c', t0 + 2, 'lol'),
    ];
    a.ingestMessages([sure, unsure, none], ARRIVAL.gateway);
    const judge = db.prepare(
      "INSERT INTO jev_judgments (message_id, subject, value, label, model, judged_at) VALUES (?, 'tag', ?, ?, 'fake', 0)",
    );
    judge.run(sure.id, TAG_AT + 0.2, 'decision');
    judge.run(unsure.id, TAG_AT - 0.2, 'plan');
    judge.run(none.id, 0.99, 'none');
    registerTags();
    expect(messagePage(db, { channelId: 'c', limit: 10 }).map((m) => m.labels)).toEqual([
      [{ subject: TAG_SUBJECT, text: 'decision', title: "Jev's label for this message (a model's estimate)" }],
      [],
      [],
    ]);
  });
});
