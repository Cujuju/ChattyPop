import { describe, expect, it } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { servedReadViolations } from '../scripts/pluginScan/servedReads';
import { CORE_SYNC_READ_ROWS_MAX } from '../src/core/plugins/syncReadBudget';

const plugin = definePlugin({ manifest: { id: 'defaultreads', name: 'Default read guard', version: '1', description: '' },
  channels: defineChannels<{ core: { omitted(): unknown; writing(): unknown; point(id: string): unknown; scan(): unknown; rows(): unknown } }>()({ core: {
    omitted: ['renderer'], writing: { audiences: ['renderer'], writes: true },
    point: { audiences: ['renderer'], syncReads: { reason: 'A unique message id lookup.' } },
    scan: { audiences: ['renderer'], syncReads: { reason: 'A deliberately invalid aggregate exception.' } },
    rows: { audiences: ['renderer'], syncReads: { reason: 'A deliberately oversized indexed page.' } },
  } }),
});

describe('default served read contract', () => {
  it('enforces omitted flags and write members, retaining only budgeted indexed lookup exceptions', async () => {
    const t = testPlugin(defineCorePlugin(plugin, (ctx) => {
      const statement = ctx.storage.db.prepare('SELECT COUNT(*) FROM archive_messages');
      ctx.channels.serve({
        omitted: async () => { await Promise.resolve(); return statement.get(); },
        writing: () => statement.get(),
        point: (id) => ctx.storage.db.prepare('SELECT id FROM archive_all_messages WHERE id = ?').get(id),
        scan: () => statement.get(),
        rows: () => ctx.storage.db.prepare('SELECT id FROM archive_all_messages WHERE channel_id = ?').all('c'),
      });
    }), { archive: { channels: [{ id: 'c' }], messages: Array.from({ length: CORE_SYNC_READ_ROWS_MAX + 1 }, (_, n) => ({ id: String(n), channelId: 'c', content: 'hello' })) } });
    try {
      const client = t.client('renderer');
      await expect(client.omitted()).rejects.toThrow('plugin-sync-read: defaultreads.omitted');
      await expect(client.writing()).rejects.toThrow('plugin-sync-read: defaultreads.writing');
      expect(await client.point('0')).toEqual({ id: '0' });
      await expect(client.scan()).rejects.toThrow('plugin-sync-read');
      await expect(client.rows()).rejects.toThrow('plugin-sync-read');
    } finally { await t.dispose(); }
  });

  it('finds unmarked served scans through helpers, including previously prepared statements', () => {
    const files = [
      { rel: 'core/index.ts', text: `ctx.channels.serve({ totals: () => totals(db), mutate: () => change(db) });` },
      { rel: 'core/queries.ts', text: `const prepared = db.prepare('SELECT COUNT(*) FROM archive_messages');
        export function totals(db: unknown) { return prepared.get(); }
        function change(db: any) { return scan(db); }
        function scan(db: any) { return db.prepare('SELECT id FROM archive_messages').all(); }` },
    ];
    const errors = servedReadViolations(files);
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('served totals');
    expect(errors.join('\n')).toContain('served mutate');
    expect(servedReadViolations([{ rel: 'core/index.ts', text: `ctx.channels.serve({ totals: () => ctx.storage.read('SELECT COUNT(*) FROM archive_messages') });` }])).toEqual([]);
  });
});
