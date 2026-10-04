// Managed-rule adoption preserves stored identity and related alert data.
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { checkBundled } from '@shared/bundledCheck';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { setSetting, type Db } from '../src/core/db';
import { tempDb } from './helpers';

const ARMED_AT = 1234;
const CREATED_AT = 1000;
const adopter = definePlugin({
  manifest: {
    id: 'probe',
    name: 'Probe',
    version: '1',
    description: 'Managed-rule adoption probe.',
  },
  adopts: {
    managedRules: {
      legacy_watch: 'watch',
    },
  },
});

function insertManaged(db: Db, key: string): number {
  return Number(db.prepare(
    `INSERT INTO rules (name, spec, enabled, position, armed_at, discord_send, created_at, builtin)
     VALUES ('Owner name', '{}', 0, 0, ?, 0, ?, ?)`,
  ).run(
    ARMED_AT,
    CREATED_AT,
    key,
  ).lastInsertRowid);
}

describe('managed-rule adoption', () => {
  it('keeps ids, armed times, owner edits and alerts through repeated adoption', () => {
    const db = tempDb();
    const id = insertManaged(db, 'legacy_watch');
    db.prepare(
      `INSERT INTO alerts (rule_id, message_id, channel_id, author_id, ts, snippet, created_at)
       VALUES (?, 'message', 'channel', 'author', ?, 'Kept', ?)`,
    ).run(
      id,
      ARMED_AT,
      CREATED_AT,
    );
    const before = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Record<string, unknown>;
    const alerts = db.prepare('SELECT * FROM alerts').all();
    adoptBundledData(db, [adopter]);
    adoptBundledData(db, [adopter]);
    expect(db.prepare('SELECT * FROM rules WHERE id = ?').get(id)).toEqual({
      ...before,
      builtin: 'probe.watch',
    });
    expect(db.prepare('SELECT * FROM alerts').all()).toEqual(alerts);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('leaves existing source and destination rows alone on a key collision', () => {
    const db = tempDb();
    insertManaged(db, 'legacy_watch');
    insertManaged(db, 'probe.watch');
    const before = db.prepare('SELECT * FROM rules ORDER BY id').all();
    adoptBundledData(db, [adopter]);
    expect(db.prepare('SELECT * FROM rules ORDER BY id').all()).toEqual(before);
  });

  it('does nothing when the declaring plugin is absent', () => {
    const db = tempDb();
    const id = insertManaged(db, 'legacy_watch');
    adoptBundledData(db, []);
    expect(db.prepare('SELECT builtin FROM rules WHERE id = ?').pluck().get(id)).toBe('legacy_watch');
  });

  it('adopts a disabled plugin without enabling or re-arming its managed rule', () => {
    const db = tempDb();
    const id = insertManaged(db, 'legacy_watch');
    setSetting(db, 'plugins.disabled', ['probe']);
    adoptBundledData(db, [adopter]);
    expect(db.prepare('SELECT builtin, enabled, armed_at FROM rules WHERE id = ?').get(id)).toEqual({
      builtin: 'probe.watch',
      enabled: 0,
      armed_at: ARMED_AT,
    });
  });

  it('rejects ambiguous ownership and invalid local keys before startup', () => {
    expect(() => checkBundled([adopter])).not.toThrow();
    expect(() => checkBundled([adopter, {
      ...adopter,
      manifest: {
        ...adopter.manifest,
        id: 'other',
      },
    }])).toThrow(/adopted managed rule/);
    expect(() => checkBundled([{
      ...adopter,
      adopts: {
        managedRules: {
          old: 'other.watch',
        },
      },
    }])).toThrow(/local identifier/);
    expect(() => checkBundled([{
      ...adopter,
      adopts: {
        managedRules: {
          one: 'watch',
          two: 'watch',
        },
      },
    }])).toThrow(/managed rule destination/);
  });
});
