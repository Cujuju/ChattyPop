// Host saved-message state owns RPCs. Panels and dialogs consume it; no saved content is persisted locally.
import { createEffect, createSignal, on } from 'solid-js';
import { containedRoot } from '@plugin-sdk/renderer/containment';
import { api } from '@/api';
import { normalizeSavedPlace, savedKey, savedWithin, type ReminderPreset, type SavedPlace, type SavedMessage, type SavedRemove, type SavedSource, type SavedTarget } from '@shared/savedMessages';
import type { MenuItem } from '@/ui/menuTypes';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { channelById, isThread } from './directory';
import { failureNotice } from './dialogs';
import { onAppEvent } from './events';
import { postingUnlocked, closeWhenLocked } from './posting';
import { contextMenu, setContextMenu } from './ui';
import { openPanel } from './layout';
import { openArchiveAt } from './archive';
import { now } from './clock';
import { unreadCounts } from './unreadCounts';
import { SavedMessageStore, type SavedState } from './savedMessageStore';

const [snapshot, setSnapshot] = createSignal<SavedState>();
const store = new SavedMessageStore(api.discord, (s) => setSnapshot(s));
export const savedMessages = (): SavedState => snapshot() ?? store.state;
export const refreshSavedMessages = (): Promise<void> => store.refresh(true);
export const loadMoreBookmarks = (): Promise<void> => store.loadMore();
export const [savedBusy, setSavedBusy] = createSignal(false);
export const [savedTab, setSavedTab] = createSignal<'bookmarks' | 'reminders'>('bookmarks');

/** Where the Bookmarks panel lists saved messages from; null: everywhere. */
export const [savedPlace, setSavedPlace] = createSetting<SavedPlace | null>(SETTINGS_KEYS.bookmarksPlace, null, normalizeSavedPlace);
export const [savedChannelsHidden, setSavedChannelsHidden] = createSetting<boolean>(SETTINGS_KEYS.bookmarksChannelsHidden, false, (v) => v === true);
/** A thread's channel, else null, as the directory knows it. Reactive. */
export const threadParent = (channelId: string): string | null => {
  const c = channelById(channelId);
  return c && isThread(c) ? c.parentId : null;
};
/** Whether `row` is in the Bookmarks panel's place. Reactive. */
export const inSavedPlace = (row: SavedMessage): boolean => savedWithin(row, savedPlace(), threadParent);
let mounted = 0;
export function mountSavedMessages(): () => void { mounted++; void store.refresh(); return () => { mounted--; }; }
/** Message menus offer Bookmark and Remind only from a read index, so it is read whenever posting is on, not only while the panel shows. */
const readIndex = (): void => { if (postingUnlocked()) void store.refresh(false, mounted > 0); };
containedRoot(() => createEffect(on(postingUnlocked, (unlocked) => { if (unlocked) readIndex(); })));

interface ReminderDraft extends SavedRemove { source: SavedSource; summary: string; dueAt: string | null }
export const [reminderDraft, setReminderDraft] = createSignal<ReminderDraft | null>(null);
export const closeReminder = (): void => void setReminderDraft(null);
closeWhenLocked(() => reminderDraft() !== null, closeReminder);
function clear(): void { store.clear(); closeReminder(); setContextMenu(null); }
onAppEvent('privacy-changed', () => { clear(); readIndex(); });
onAppEvent('discord-session', (e) => { if (e.state === 'signed-out') clear(); });
onAppEvent('saved-messages-changed', (e) => {
  const reset = e.reset || e.session !== savedMessages().session;
  const contentChanged = reset || e.revision !== savedMessages().revision;
  store.invalidate(e.session, e.revision, reset, e.pageEpoch);
  if (contentChanged) {
    if (reminderDraft() && !savedBusy()) failureNotice('Reminder closed')(new Error('Saved messages changed. Reopen the reminder to use the current state.'));
    closeReminder();
    if (contextMenu()?.messageId) setContextMenu(null);
  }
  if (e.session !== null) readIndex();
});
unreadCounts.host('bookmarks', { count: () => savedMessages().reminders.filter((m) => m.dueAt !== null && Date.parse(m.dueAt) <= now()).length });

const targetAt = (target: SavedTarget, session: string, revision = savedMessages().revision): SavedRemove => ({ channelId: target.channelId, messageId: target.messageId, session, revision });
async function write(run: () => Promise<void>, session: string): Promise<void> {
  if (savedBusy()) throw new Error('Wait for the saved-message change to finish.');
  if (!postingUnlocked()) throw new Error('Posting is off: it needs a plugin that turns it on.');
  if (savedMessages().session !== session) throw new Error('The Discord account changed. Refresh saved messages.');
  setSavedBusy(true);
  try { await run(); }
  finally { setSavedBusy(false); }
}
export async function bookmarkMessage(target: SavedTarget, session: string, source: SavedSource, revision = savedMessages().revision): Promise<void> {
  await write(() => api.discord.saveMessage({ ...targetAt(target, session, revision), source }), session);
}
export async function removeSavedMessage(target: SavedTarget, session: string, revision = savedMessages().revision): Promise<void> {
  await write(() => api.discord.removeSavedMessage(targetAt(target, session, revision)), session);
}
export async function saveReminder(draft: ReminderDraft, dueAt: string): Promise<void> {
  await write(() => api.discord.saveMessage({ ...targetAt(draft, draft.session, draft.revision), source: draft.source, dueAt }), draft.session);
}
export function editReminder(row: SavedMessage, session = savedMessages().session): void {
  if (session && postingUnlocked()) setReminderDraft({ ...targetAt(row, session), source: 'for_later_list', summary: row.summary, dueAt: row.dueAt });
}
export const openSavedMessage = async (row: SavedMessage): Promise<void> => { if (!(await api.core.messageById(row.messageId))) throw new Error('This message is not in the archive. Open it in the live Discord client.'); await openArchiveAt({ channelId: row.channelId, messageId: row.messageId, bottom: 0 }); };
export const reminderPresetLabel = (preset: ReminderPreset): string => ({ '10m': 'In 10 minutes', '30m': 'In 30 minutes', '1h': 'In 1 hour', '4h': 'In 4 hours', morning: 'At 9am today / tomorrow', monday: 'Monday at 9am' })[preset];

/** Callbacks capture their original session, so a stale menu cannot write against a newly signed-in account. */
export function savedMenuItems(target: SavedTarget & { summary: string }): MenuItem[] {
  const state = savedMessages(), session = state.session;
  const open: MenuItem = { label: 'View bookmarks and reminders…', icon: 'archive', run: () => openPanel('bookmarks') };
  const submenu = (items: MenuItem[]): MenuItem[] => [{ label: 'Bookmarks and reminders', icon: 'archive', submenu: [...(items.length ? [{ items }] : []), { items: [open] }] }];
  if (!session || state.stale || !postingUnlocked() || savedBusy()) return submenu([]);
  const reminder = state.reminders.find((m) => savedKey(m) === savedKey(target));
  if (!reminder && !state.bookmarkIds.includes(target.messageId) && !state.writableChannelIds.includes(target.channelId)) return submenu([]);
  const draft: ReminderDraft = { ...targetAt(target, session), source: 'context_menu', summary: target.summary, dueAt: reminder?.dueAt ?? null };
  const run = (fn: () => Promise<void>): (() => Promise<void>) => () => fn().catch(failureNotice("Couldn't change saved messages"));
  const items: MenuItem[] = reminder ? [
    { label: 'Mark reminder complete', icon: 'check', run: run(() => removeSavedMessage(target, session, state.revision)) },
  ] : [{ label: state.bookmarkIds.includes(target.messageId) ? 'Remove bookmark' : 'Bookmark', icon: 'archive', run: run(() => state.bookmarkIds.includes(target.messageId) ? removeSavedMessage(target, session, state.revision) : bookmarkMessage(target, session, 'context_menu', state.revision)) }];
  items.push({ label: reminder ? 'Edit reminder…' : 'Remind me…', icon: 'clock', run: () => { if (savedMessages().session === session && savedMessages().revision === state.revision && postingUnlocked()) setReminderDraft(draft); } });
  return submenu(items);
}
