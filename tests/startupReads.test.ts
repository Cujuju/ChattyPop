import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@shared/permissions';
import { setSetting, compressRawJson } from '../src/core/db';
import { ownCommands } from '../src/core/queries/ownCommands';
import { savedWritableChannels } from '../src/core/queries/savedMessages';
import { ownCommandsAsync, savedWritableChannelsAsync, syncStateAsync } from '../src/core/queries/hostAsync';
import { archiveReadPrivacyChanged, closeArchiveReads } from '../src/core/reads/archiveReads';
import { RuleCatchUp } from '../src/core/rules/catchUp';
import { CATCH_UP_PAGE_ROWS, CATCH_UP_TURN_ROWS } from '../src/core/rules/catchUpRead';
import { legacySavedWritableChannels } from './startupLegacy';
import { seedArchive, tempDb } from './helpers';

describe('startup reads', () => {
  it('preserves command, permission and cursor results in helpers, including privacy and cancellation', async () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'open' }, { id: 'hidden', guildId: 'hidden-guild' }],
      { guilds: [{ id: 'g1', name: 'Open' }, { id: 'hidden-guild', name: 'Hidden' }] });
    archive.applyRoleChange({ kind: 'replace', guildId: 'g1', roles: [
      { id: 'g1', name: '@everyone', position: 0, permissions: String(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY) },
    ] });
    db.prepare('UPDATE guilds SET hide_in_privacy = 1 WHERE id = ?').run('hidden-guild');
    const put = db.prepare('INSERT INTO messages (id, channel_id, author_id, ts, content, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
    put.run('one', 'open', 'app', 1, 'visible', compressRawJson(JSON.stringify({ application_id: 'app', interaction: { name: 'old', user: { id: 'owner' }, type: 2 } })));
    put.run('two', 'hidden', 'app', 2, 'hidden', compressRawJson(JSON.stringify({ interaction_metadata: { name: 'new', user: { id: 'owner' }, type: 2 } })));
    try {
      for (const privacy of [false, true, false]) {
        setSetting(db, 'privacyMode', privacy);
        const commands = ownCommands(db, 'owner', 50), writable = legacySavedWritableChannels(db, 'owner');
        expect(savedWritableChannels(db, 'owner')).toEqual(writable);
        const state = archive.syncState('open');
        const sql = vi.spyOn(db, 'prepare');
        try {
          expect(await ownCommandsAsync(db, 'owner', 50)).toEqual(commands);
          expect(await savedWritableChannelsAsync(db, 'owner')).toEqual(writable);
          expect(await syncStateAsync(db, 'open')).toEqual(state);
          expect(await syncStateAsync(db, 'missing')).toEqual({ channelId: 'missing', count: 0, oldestId: null, newestId: null, backfillComplete: false });
          expect(sql).not.toHaveBeenCalled();
        } finally { sql.mockRestore(); }
      }
      const cancel = new AbortController(); cancel.abort(new Error('Superseded startup read'));
      for (const pending of [ownCommandsAsync(db, 'owner', 50, cancel.signal), savedWritableChannelsAsync(db, 'owner', cancel.signal), syncStateAsync(db, 'open', cancel.signal)])
        await expect(pending).rejects.toBe(cancel.signal.reason);
      const pending = savedWritableChannelsAsync(db, 'owner');
      archiveReadPrivacyChanged(db);
      await expect(pending).rejects.toThrow('visibility changed');
    } finally { await closeArchiveReads(db); db.close(); }
  });

  it('matches the legacy permission projection for overwrites, thread parents, absent facts, owners and DMs', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'parent' }, { id: 'denied' }]);
    archive.applyRoleChange({ kind: 'replace', guildId: 'g1', roles: [
      { id: 'g1', name: '@everyone', position: 0, permissions: String(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY) },
    ] });
    archive.upsertChannels('g1', [
      { id: 'denied', name: 'Denied', type: 0, permission_overwrites: [{ id: 'g1', type: 0, allow: '0', deny: String(PERMISSIONS.READ_MESSAGE_HISTORY) }] },
      { id: 'public-thread', name: 'Public', type: 11, parent_id: 'denied' },
      { id: 'private-thread', name: 'Private', type: 12, parent_id: 'parent' },
      { id: 'absent-parent', name: 'Absent', type: 12, parent_id: 'missing' },
      { id: 'null-parent', name: 'Null', type: 11 },
    ]);
    archive.replacePrivateChannels('owner', [{ id: 'dm', type: 1, recipients: [{ id: 'peer', username: 'peer' }] }], false, Date.now());
    try {
      for (const ownerId of [null, 'owner']) for (const privacy of [false, true]) {
        db.prepare('UPDATE guilds SET owner_id = ?').run(ownerId);
        archive.setChannelPolicy('parent', { hideInPrivacy: true });
        setSetting(db, 'privacyMode', privacy);
        for (const account of ['owner', 'other']) expect(savedWritableChannels(db, account)).toEqual(legacySavedWritableChannels(db, account));
      }
    } finally { db.close(); }
  });
});

/** Crosses a helper page and several callback turns, including equal timestamps. */
const CATCH_UP_MESSAGES = CATCH_UP_PAGE_ROWS + CATCH_UP_TURN_ROWS;
function catchUpFixture() {
  const db = tempDb(); seedArchive(db, [{ id: 'c' }]);
  const put = db.prepare("INSERT INTO messages (id, channel_id, author_id, ts, content) VALUES (?, 'c', 'u', ?, ?)");
  const now = Date.now();
  db.transaction(() => { for (let n = 0; n < CATCH_UP_MESSAGES; n++) put.run(String(n), now, `message ${n}`); })();
  return { db, put, now };
}

describe('yielded rule catch-up', () => {
  it('visits every original message once, excludes later arrivals and skips stale text before callbacks', async () => {
    const { db, put, now } = catchUpFixture();
    const seen: string[] = [], batches: number[] = [];
    const queue = new RuleCatchUp(db, (messages) => {
      batches.push(messages.length); seen.push(...messages.map((m) => m.id));
      if (batches.length === 1) {
        put.run('later', now, 'new live arrival');
        db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited live', String(CATCH_UP_TURN_ROWS));
        db.prepare('DELETE FROM messages WHERE id = ?').run(String(CATCH_UP_TURN_ROWS + 1));
      }
    });
    try {
      await queue.request();
      expect(batches.every((n) => n <= CATCH_UP_TURN_ROWS)).toBe(true);
      expect(seen).toEqual(Array.from({ length: CATCH_UP_MESSAGES }, (_, n) => String(n)).filter((id) => ![String(CATCH_UP_TURN_ROWS), String(CATCH_UP_TURN_ROWS + 1)].includes(id)));
    } finally { queue.dispose(); await closeArchiveReads(db); db.close(); }
  });

  it.each(['dispose', 'privacy'] as const)('stops callbacks after %s interrupts a yielded pass', async (reason) => {
    const { db } = catchUpFixture();
    let calls = 0;
    const queue = new RuleCatchUp(db, () => {
      calls++;
      if (reason === 'dispose') queue.dispose(); else archiveReadPrivacyChanged(db);
    });
    try {
      await expect(queue.request()).rejects.toThrow(reason === 'dispose' ? 'catch-up stopped' : 'visibility changed');
      expect(calls).toBe(1);
    } finally { queue.dispose(); await closeArchiveReads(db); db.close(); }
  });

  it('retains a rerun requested while a privacy change cancels the active snapshot', async () => {
    const { db } = catchUpFixture();
    const seen = new Set<string>();
    let changed = false;
    const queue = new RuleCatchUp(db, (messages) => {
      for (const m of messages) seen.add(m.id);
      if (!changed) { changed = true; archiveReadPrivacyChanged(db); void queue.request(true); }
    });
    try { await queue.request(); expect(seen.size).toBe(CATCH_UP_MESSAGES); }
    finally { queue.dispose(); await closeArchiveReads(db); db.close(); }
  });
});
