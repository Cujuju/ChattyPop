import { describe, expect, it, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { compressRawJson, setSetting } from '../src/core/db';
import { archiveAsync } from '../src/core/plugins/archiveAsync';
import { archivePayloads } from '../src/core/plugins/archivePayloads';
import { messagesByIds } from '../src/core/queries/messages';
import { closeArchiveReads } from '../src/core/reads/archiveReads';
import { pluginCalls } from '../src/core/plugins/callContext';
import { seedArchiveViews } from './archiveViewsFixture';
import { tempDb } from './helpers';
import { messageParts } from '../src/core/messageParts';
import { partTexts } from '../src/core/derivedText';

describe('host archive projections follow the read contract', () => {
  it('reads compressed payloads and privacy-filtered messages off Core with synchronous parity', async () => {
    const db = tempDb();
    seedArchiveViews(db);
    db.prepare("UPDATE messages SET raw_json = ? WHERE id = 'm-open'").run(compressRawJson('{"embeds":[{"type":"rich","title":"Compressed"}],"flags":8192}'));
    const read = archiveAsync(() => db, () => true);
    const ids = ['m-open', 'm-hide', 'absent'];
    try {
      for (const privacy of [false, true, false]) {
        setSetting(db, 'privacyMode', privacy);
        const expectedMessages = messagesByIds(db, ids), expectedPayloads = archivePayloads(db, ids);
        const expectedParts = { parts: messageParts(db, ids), texts: partTexts(db, ids) };
        const coreQueries = vi.spyOn(db, 'prepare');
        try {
          expect(await read.messages(ids)).toEqual(expectedMessages);
          expect(await read.payloads(ids)).toEqual(expectedPayloads);
          expect(await read.parts(ids)).toEqual(expectedParts);
          expect(coreQueries).not.toHaveBeenCalled();
        } finally { coreQueries.mockRestore(); }
      }
      const controller = new AbortController(); controller.abort(new Error('Call superseded'));
      await expect(pluginCalls.run({ plugin: 'probe', member: 'page', reads: true, signal: controller.signal, priority: 'interactive', strict: true, diag: vi.fn() },
        () => read.messages(ids))).rejects.toBe(controller.signal.reason);
      await expect(read.payloads(ids, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    } finally { await closeArchiveReads(db); db.close(); }
  });

  it('fences synchronous host projections and preserves live indexed decorations on asynchronous pages', async () => {
    const messageId = '1000000000000000000';
    const descriptor = definePlugin({ manifest: { id: 'hostreads', name: 'Host reads', version: '1', description: '' },
      channels: defineChannels<{ core: { messages(): unknown; payloads(): unknown; parts(): unknown; images(): unknown; page(): unknown } }>()({
        core: { messages: ['renderer'], payloads: ['renderer'], parts: ['renderer'], images: ['renderer'], page: ['renderer'] },
      }),
    });
    const t = testPlugin(defineCorePlugin(descriptor, (ctx) => {
      ctx.archive.notes.provide((ids) => new Map(ctx.storage.db.prepare('SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(ids)).map((r) => [(r as { id: string }).id, new Map([['link-text:https://example.com', { kind: 'text', label: 'Live note', text: 'Current', state: 'done' }]])])));
      ctx.archive.messageLabels.provide((ids) => new Map(ids.map((id) => [id, [{ subject: 'probe', text: 'Live label', title: 'Current' }]])));
      ctx.channels.serve({
        messages: () => ctx.archive.messages([messageId]), payloads: () => ctx.archive.payloads([messageId]),
        parts: () => ctx.archive.parts.of([messageId]), images: () => ctx.archive.images.of([messageId]),
        page: () => ctx.archive.read.messages([messageId]),
      });
    }), { archive: { channels: [{ id: 'c' }], messages: [{ id: messageId, channelId: 'c', content: 'Hello' }] } });
    try {
      const client = t.client('renderer');
      for (const method of ['messages', 'payloads', 'parts', 'images'] as const) await expect(client[method]()).rejects.toThrow(`plugin-sync-read: hostreads.${method}`);
      const page = await client.page() as { labels: unknown[]; notes: unknown[] }[];
      expect(page[0]!.labels).toContainEqual({ subject: 'probe', text: 'Live label', title: 'Current', pluginId: 'hostreads' });
      expect(page[0]!.notes).toHaveLength(1);
      expect(t.status().error).toBeNull();
    } finally { await t.dispose(); }
  });
});
