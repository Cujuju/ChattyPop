import { describe, expect, it } from 'vitest';
import { SETTINGS_KEYS } from '@shared/settings';
import { PERMISSIONS } from '@shared/permissions';
import { savedKey, type SavedMessage } from '@shared/savedMessages';
import { RENDERER_CORE_METHODS } from '@shared/rendererApi';
import { PHONE_CORE_METHODS } from '@shared/phone';
import { setSetting } from '../src/core/db';
import { ARRIVAL } from '../src/core/arrival';
import { filterSavedMessages, savedTargetVisible, savedWritableChannels } from '../src/core/queries/savedMessages';
import { rawMessage, seedArchive, tempDb } from './helpers';

const OPEN = '100000000000000001', HIDDEN = '100000000000000002', GUILD = '300000000000000001';
const saved = (channelId: string, messageId: string, summary = 'hello', guildId: string | null = null): SavedMessage => ({ channelId, messageId, summary, guildId, savedAt: '2026-10-01T12:00:00Z', dueAt: null, authorName: 'Alice', channelName: '#general', available: false });
describe('native saved content privacy', () => {
  it('fills missing presentation metadata from a visible archived message, including a deleted original', () => {
    const db = tempDb(), archive = seedArchive(db, [{ id: OPEN, name: 'general' }]);
    const author = { id: '400000000000000001', username: 'alice', global_name: 'Alice', avatar: 'a'.repeat(32) };
    const original = rawMessage(OPEN, Date.now(), 'local content', { author });
    archive.ingestMessages([original], ARRIVAL.sync);
    const row = { ...saved(OPEN, original.id, 'saved summary'), authorName: '', channelName: '' };
    expect(filterSavedMessages(db, [row], []).items[0]).toMatchObject({
      authorName: 'Alice', channelName: '#general', author: { id: author.id, avatar: author.avatar }, summary: 'saved summary', available: false,
    });
  });
  it('scans enriched author metadata for hidden references and never enriches from a hidden message', () => {
    const db = tempDb(), archive = seedArchive(db, [{ id: OPEN, name: 'general' }, { id: HIDDEN, name: 'private' }]);
    archive.setChannelPolicy(HIDDEN, { hideInPrivacy: true }); setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const author = { id: '400000000000000001', username: 'alice', global_name: `See ${HIDDEN}`, avatar: 'a'.repeat(32) };
    const original = rawMessage(OPEN, Date.now(), 'plain content', { author });
    const hidden = rawMessage(HIDDEN, Date.now() + 1, 'private content');
    archive.ingestMessages([original, hidden], ARRIVAL.sync);
    expect(filterSavedMessages(db, [{ ...saved(OPEN, original.id), authorName: '' }, saved(HIDDEN, hidden.id)], []).items).toEqual([]);
  });
  it('permits new saves only with read history, current-account open DMs and visible scope', () => {
    const db = tempDb(), owner = '400000000000000001', dm = '100000000000000004';
    const archive = seedArchive(db, [{ id: OPEN, guildId: GUILD, name: 'general' }], { guilds: [{ id: GUILD, name: 'guild' }] });
    const role = { id: GUILD, name: '@everyone', position: 0, permissions: (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY).toString() };
    archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [role] });
    archive.upsertPrivateChannel(owner, { id: dm, type: 1, recipients: [{ id: '400000000000000002', username: 'peer' }] }, true);
    expect(savedWritableChannels(db, owner).map((c) => c.channelId)).toEqual([OPEN, dm]);
    expect(savedWritableChannels(db, '400000000000000003').map((c) => c.channelId)).not.toContain(dm);
    archive.applyRoleChange({ kind: 'replace', guildId: GUILD, roles: [{ ...role, permissions: PERMISSIONS.VIEW_CHANNEL.toString() }] });
    expect(savedWritableChannels(db, owner).map((c) => c.channelId)).toEqual([dm]);
    db.prepare('UPDATE channels SET closed_at = 1 WHERE id = ?').run(dm);
    expect(savedWritableChannels(db, owner)).toEqual([]);
    expect(RENDERER_CORE_METHODS).not.toContain('savedWritableChannels'); expect(PHONE_CORE_METHODS).not.toContain('savedWritableChannels');
  });
  it('filters hidden channels, unknown rows from hidden guilds, and hidden references outside the archive', () => {
    const db = tempDb(), archive = seedArchive(db, [{ id: OPEN, name: 'general' }, { id: HIDDEN, name: 'hidden', guildId: GUILD }], { guilds: [{ id: '300000000000000002', name: 'public' }, { id: GUILD, name: 'private' }] });
    archive.setGuildHideInPrivacy(GUILD, true); setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const rows = [saved(OPEN, '200000000000000001'), saved(HIDDEN, '200000000000000002'), saved(OPEN, '200000000000000003', `see <#${HIDDEN}>`), saved('100000000000000003', '200000000000000004', 'plain', GUILD)];
    const result = filterSavedMessages(db, rows, rows.map((m) => m.messageId));
    expect(result.items.map(savedKey)).toEqual([savedKey(rows[0]!)]);
    expect(result.bookmarkIds).toEqual([rows[0]!.messageId]);
    expect(savedTargetVisible(db, rows[1]!)).toBe(false);
    const unknownThread = saved('100000000000000099', '200000000000000099', 'no hidden mention');
    expect(savedTargetVisible(db, unknownThread)).toBe(false);
    expect(filterSavedMessages(db, [unknownThread], []).items).toEqual([]);
    setSetting(db, SETTINGS_KEYS.privacyMode, false);
    expect(savedTargetVisible(db, unknownThread)).toBe(true);
  });
  it('exposes bare bookmark identities only when their archived content is visible and retains summaries after deletion', () => {
    const db = tempDb(), archive = seedArchive(db, [{ id: OPEN, name: 'general' }, { id: HIDDEN, name: 'hidden' }]);
    archive.setChannelPolicy(HIDDEN, { hideInPrivacy: true }); setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const one = rawMessage(OPEN, Date.now(), 'plain'), two = rawMessage(OPEN, Date.now() + 1, `link ${HIDDEN}`), three = rawMessage(HIDDEN, Date.now() + 2, 'secret');
    archive.ingestMessages([one, two, three], ARRIVAL.sync);
    expect(savedTargetVisible(db, { channelId: HIDDEN, messageId: one.id })).toBe(false);
    setSetting(db, SETTINGS_KEYS.privacyMode, false);
    expect(savedTargetVisible(db, { channelId: HIDDEN, messageId: one.id })).toBe(false);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const ids = [one.id, two.id, three.id, '200000000000000004'];
    expect(filterSavedMessages(db, [], ids).bookmarkIds).toEqual([one.id]);
    expect(savedTargetVisible(db, { channelId: OPEN, messageId: two.id })).toBe(false);
    expect(filterSavedMessages(db, [saved(OPEN, '200000000000000009', 'deleted summary')], []).items[0]?.summary).toBe('deleted summary');
  });
  it('does not grant renderers or phones the new main-only core filters', () => {
    expect(RENDERER_CORE_METHODS).not.toContain('filterSavedMessages');
    expect(RENDERER_CORE_METHODS).not.toContain('savedTargetVisible');
    expect(PHONE_CORE_METHODS).not.toContain('filterSavedMessages');
    expect(PHONE_CORE_METHODS).not.toContain('savedTargetVisible');
  });
});
