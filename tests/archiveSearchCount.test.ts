import { describe, expect, it, onTestFinished } from 'vitest';
import { ARRIVAL } from '@core/arrival';
import type { Db } from '@core/db';
import { archiveSearch } from '@core/queries/archiveSearch';
import { archiveSearchCount } from '@core/queries/archiveSearchCount';
import { rawMessage, seedArchive, tempDb } from './helpers';

const START = Date.UTC(2026, 8, 1);

function start() {
  const db = tempDb();
  onTestFinished(() => { db.close(); });
  const archive = seedArchive(db, [{ id: 'c1' }]);
  const messages = [rawMessage('c1', START, 'quartz'), rawMessage('c1', START + 1, 'quartz'), rawMessage('c1', START + 2, 'quartz')];
  archive.ingestMessages(messages, ARRIVAL.sync);
  return { db, messages };
}

describe('archive count query execution', () => {
  it('shares the optional removed-message scope with search', () => {
    const { db, messages } = start();
    db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(START, messages[1]!.id);
    db.prepare('UPDATE messages SET pruned_at = ? WHERE id = ?').run(START, messages[2]!.id);
    for (const excludeRemoved of [false, true]) {
      const opts = { channelIds: ['c1'], limit: 100, excludeRemoved };
      const count = excludeRemoved ? 1 : 3;
      expect(archiveSearch(db, 'quartz', opts)).toHaveLength(count);
      expect(archiveSearchCount(db, 'quartz', opts, 'channel')).toMatchObject([{ key: 'c1', count }]);
      expect(archiveSearchCount(db, null, opts, 'channel')).toMatchObject([{ key: 'c1', count }]);
    }
  });

  it('starts each text branch at FTS and looks up message candidates by index', () => {
    const { db } = start();
    let plan: string[] = [];
    const reader = {
      prepare(sql: string) {
        return { all(...params: (string | number)[]) {
          plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
          return db.prepare(sql).all(...params);
        } };
      },
    } as unknown as Db;
    expect(archiveSearchCount(reader, 'quartz', { channelIds: ['c1'], since: START, limit: 1 }, 'channel'))
      .toMatchObject([{ key: 'c1', count: 3 }]);
    for (const alias of ['f', 'fd', 'fl']) {
      expect(plan.some((step) => step.startsWith(`SCAN ${alias} VIRTUAL TABLE INDEX`) && step.includes('M1'))).toBe(true);
    }
    expect(plan.filter((step) => /^SEARCH m USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex_messages_1)/.test(step))).toHaveLength(4);
    expect(plan.some((step) => /^SCAN m\b/.test(step))).toBe(false);
    expect(plan.join('\n')).not.toContain('archive_messages');
  });
});
