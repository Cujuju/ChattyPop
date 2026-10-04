// ctx.archive.replyTargets reads the target Discord embeds in a reply (referenced_message), never the archived copy
// (docs/plugin-architecture.md §3, archive replies).
import { describe, expect, it } from 'vitest';
import { compressRawJson } from '../src/core/db';
import { ARRIVAL } from '../src/core/arrival';
import { REPLY_MESSAGE_TYPE } from '../src/core/queries/messageExtras';
import { seedArchive, rawMessage } from './helpers';
import { startReadProbe as start } from './pluginReadHarness';

describe('archive.replyTargets', () => {
  it('keeps the embedded target’s author and text, archived or not, compressed or not', async () => {
    const p = start(() => undefined);
    const now = Date.now();
    // As Discord sends a reply: type 19, the reference, and a full copy of the target with its author.
    const target = rawMessage('c1', now - 2_000, 'who has the doc?', { author: { id: 'u3', username: 'carol', global_name: 'Carol' } });
    const reply = rawMessage('c1', now - 1_000, 'I do', {
      author: { id: 'u4', username: 'bob' },
      type: REPLY_MESSAGE_TYPE,
      message_reference: { message_id: target.id, channel_id: 'c1', guild_id: 'g1' },
      referenced_message: target,
    } as never);
    const nameless = rawMessage('c1', now - 500, 'same', {
      type: REPLY_MESSAGE_TYPE,
      message_reference: { message_id: target.id },
      referenced_message: { ...target, author: { id: 'u3', username: 'carol' }, content: 'who has the doc?' },
    } as never);
    const plain = rawMessage('c1', now, 'not a reply');
    // The target itself is not archived: its metadata comes from the reply alone.
    const archive = seedArchive(p.db, [{ id: 'c1' }]);
    archive.ingestMessages([reply, nameless, plain], ARRIVAL.gateway);
    p.db.prepare('UPDATE messages SET raw_json = ? WHERE id = ?').run(compressRawJson(JSON.stringify(nameless)), nameless.id);

    const targets = p.context().archive.replyTargets([reply.id, nameless.id, plain.id, 'missing']);
    expect(Object.fromEntries(targets)).toEqual({
      [reply.id]: { id: target.id, authorId: 'u3', author: 'Carol', content: 'who has the doc?' },
      [nameless.id]: { id: target.id, authorId: 'u3', author: 'carol', content: 'who has the doc?' },
    });

    await p.host.setEnabled('readprobe', false);
    expect(p.context().archive.replyTargets([reply.id]).size).toBe(0);
  });
});
