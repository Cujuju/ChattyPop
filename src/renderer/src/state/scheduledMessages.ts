// Scheduled sends stay separate from the retrying outbox: Discord has no nonce deduplication on this endpoint.
import { createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { api } from '@/api';
import { errorText } from '@/ui/format';
import { idbEntries, idbSet, whenWritten } from '@/ui/idbStore';
import { applyBuiltinCommand, expandEmojiTokens, expandMentionTokens } from '@shared/compose';
import { newNonce } from '@shared/discord';
import { convertEmoticons } from '@shared/emoticons';
import type { PollDraft } from '@shared/polls';
import { SCHEDULE_UNCONFIRMED, scheduleWindowError, type ScheduledAvailability, type ScheduledMessage, type ScheduledUpdate } from '@shared/scheduledMessages';
import { discordChatSettings } from './chatSettings';
import { snapshotDraft, takeDraft } from './drafts';
import { onAppEvent } from './events';
import { uploadFiles } from './outbox';
import { postingUnlocked } from './posting';
import { cancelReply, replyPing, replyTarget } from './reply';
import { prepareFiles } from './uploadPrep';

const [availability, setAvailability] = createSignal<Record<string, ScheduledAvailability>>({});
const [times, setTimes] = createSignal<Record<string, string | undefined>>({});
const [items, setItems] = createSignal<ScheduledMessage[]>([]);
const [busy, setBusy] = createSignal<Record<string, boolean>>({});
const [notices, setNotices] = createSignal<Record<string, string>>({});
const [listError, setListError] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);
const [unconfirmed, setUnconfirmed] = createSignal<Record<string, boolean>>({});
const KEY = 'scheduled-draft:';
const UNCERTAIN_KEY = 'scheduled-unconfirmed:';
let generation = 0;
let listRead = 0;
const monitored = new Set<string>();

export const scheduledTime = (channelId: string): string | undefined => times()[channelId];
export const schedulingBusy = (channelId: string): boolean => busy()[channelId] ?? false;
export const schedulingUnconfirmed = (channelId: string): boolean => unconfirmed()[channelId] ?? false;
export function clearScheduleUnconfirmed(channelId: string): void {
  setUnconfirmed((u) => ({ ...u, [channelId]: false })); idbSet(UNCERTAIN_KEY + channelId, undefined);
}
function markUnconfirmed(channelId: string): void {
  setUnconfirmed((u) => ({ ...u, [channelId]: true })); idbSet(UNCERTAIN_KEY + channelId, true);
}
export const scheduledNotice = (channelId: string): string => notices()[channelId] ?? '';
export const scheduledForChannel = (channelId: string): ScheduledMessage[] => items().filter((m) => m.create_args.channel_id === channelId).sort((a, b) => Date.parse(a.send_at_timestamp) - Date.parse(b.send_at_timestamp));
export const schedulingAvailable = (channelId: string): boolean => postingUnlocked() && (availability()[channelId]?.enabled ?? false);
export const scheduledLimit = (channelId: string): number => availability()[channelId]?.limit ?? 0;
export { listError as scheduledListError, loading as scheduledLoading };

export async function loadScheduledAvailability(channelId: string): Promise<void> {
  monitored.add(channelId);
  const epoch = generation;
  let value: ScheduledAvailability = { enabled: false, limit: 0 };
  try { value = await api.discord.scheduledAvailability(channelId); } catch { /* An older running preload needs a restart. */ }
  if (epoch === generation) setAvailability((a) => ({ ...a, [channelId]: value }));
}

export function setScheduledTime(channelId: string, timestamp: string | undefined): void {
  setTimes((t) => ({ ...t, [channelId]: timestamp }));
  idbSet(KEY + channelId, timestamp);
}

export async function refreshScheduledMessages(): Promise<void> {
  const epoch = generation;
  const read = ++listRead;
  setLoading(true);
  setListError(null);
  try {
    const fetched = await api.discord.scheduledMessages();
    if (epoch === generation && read === listRead) setItems(fetched);
  } catch (err) {
    if (epoch === generation && read === listRead) setListError(errorText(err));
  } finally {
    if (epoch === generation && read === listRead) setLoading(false);
  }
}

function accept(item: ScheduledMessage): void {
  // An older in-flight GET must not erase a successful mutation.
  ++listRead;
  setLoading(false);
  setItems((all) => [...all.filter((m) => m.scheduled_message_id !== item.scheduled_message_id), item]);
}

function scheduleFailed(channelId: string, error: unknown): never {
  const text = errorText(error);
  // Explicit unsent refusals allow correction; a lost IPC response can also hide an accepted create.
  if (/Discord 4\d\d on |limit reached|Too soon:|Too far:|unavailable in this channel|Posting is off:|account changed|Choose a valid|Write a message first|Not a /.test(text)) clearScheduleUnconfirmed(channelId);
  if (schedulingUnconfirmed(channelId)) throw new Error(SCHEDULE_UNCONFIRMED);
  throw error;
}

/** Keeps the draft until acceptance, and never retries an unconfirmed creation automatically. */
export async function scheduleDraft(channelId: string, stickerId: string | null = null): Promise<void> {
  await restoredDrafts;
  if (schedulingBusy(channelId)) return;
  if (schedulingUnconfirmed(channelId)) throw new Error(SCHEDULE_UNCONFIRMED);
  const timestamp = scheduledTime(channelId);
  if (!timestamp || !schedulingAvailable(channelId)) throw new Error('Choose an available schedule time first.');
  const target = replyTarget()?.channelId === channelId ? unwrap(replyTarget()) : null;
  const error = scheduleWindowError(Date.parse(timestamp), Date.now(), target?.id);
  if (error) throw new Error(error);
  const draft = snapshotDraft(channelId, target);
  const text = discordChatSettings().convertEmoticons ? convertEmoticons(draft.text) : draft.text;
  const content = expandMentionTokens(expandEmojiTokens(applyBuiltinCommand(text), new Map(draft.emoji)), new Map(draft.mentions));
  const epoch = generation;
  const ping = replyPing();
  setBusy((b) => ({ ...b, [channelId]: true }));
  setNotices((n) => ({ ...n, [channelId]: '' }));
  try {
    const prepared = await prepareFiles(draft.files.map((f) => f.file), await api.discord.uploadLimit(channelId), () => {});
    const files = draft.files.map((f, i) => ({ ...f, file: prepared[i]! }));
    const uploads = files.length ? await uploadFiles(channelId, files, () => {}) : [];
    if (epoch !== generation) throw new Error('The Discord account changed.');
    markUnconfirmed(channelId);
    await whenWritten();
    if (epoch !== generation) throw new Error('The Discord account changed.');
    const item = await api.discord.createScheduled({
      channelId, text: content, files: [], uploads, replyTo: target ? { messageId: target.id, ping } : null,
      stickerId, gif: null, nonce: newNonce(), scheduledTimestamp: timestamp,
    });
    if (epoch !== generation) return;
    clearScheduleUnconfirmed(channelId);
    accept(item);
    const current = snapshotDraft(channelId, target);
    if (current.text === draft.text && current.files.length === draft.files.length && current.files.every((f, i) => f.file === draft.files[i]?.file && f.description === draft.files[i]?.description && f.spoiler === draft.files[i]?.spoiler)) takeDraft(channelId, target);
    if (target && replyTarget()?.id === target.id) cancelReply();
    if (scheduledTime(channelId) === timestamp) setScheduledTime(channelId, undefined);
    setNotices((n) => ({ ...n, [channelId]: `Message scheduled for ${new Date(item.send_at_timestamp).toLocaleString()}.` }));
  } catch (error) {
    if (epoch === generation) scheduleFailed(channelId, error);
    throw error;
  } finally {
    if (epoch === generation) setBusy((b) => ({ ...b, [channelId]: false }));
  }
}

/** Poll creation sends its own draft, leaving the composer's text and files intact. */
export async function schedulePoll(channelId: string, poll: PollDraft): Promise<void> {
  await restoredDrafts;
  if (schedulingBusy(channelId)) return;
  if (schedulingUnconfirmed(channelId)) throw new Error(SCHEDULE_UNCONFIRMED);
  const timestamp = scheduledTime(channelId);
  if (!timestamp || !schedulingAvailable(channelId)) throw new Error('Choose an available schedule time first.');
  const target = replyTarget()?.channelId === channelId ? replyTarget() : null;
  const epoch = generation;
  setBusy((b) => ({ ...b, [channelId]: true }));
  try {
    markUnconfirmed(channelId);
    await whenWritten();
    if (epoch !== generation) throw new Error('The Discord account changed.');
    const item = await api.discord.createScheduled({ channelId, text: '', files: [], stickerId: null, gif: null,
      replyTo: target ? { messageId: target.id, ping: replyPing() } : null, poll, nonce: newNonce(), scheduledTimestamp: timestamp });
    if (epoch !== generation) return;
    clearScheduleUnconfirmed(channelId);
    accept(item);
    if (target && replyTarget()?.id === target.id) cancelReply();
    if (scheduledTime(channelId) === timestamp) setScheduledTime(channelId, undefined);
    setNotices((n) => ({ ...n, [channelId]: `Poll scheduled for ${new Date(item.send_at_timestamp).toLocaleString()}.` }));
  } catch (error) {
    if (epoch === generation) scheduleFailed(channelId, error);
    throw error;
  } finally {
    if (epoch === generation) setBusy((b) => ({ ...b, [channelId]: false }));
  }
}

export async function updateScheduledMessage(change: ScheduledUpdate): Promise<void> {
  const epoch = generation;
  const item = await api.discord.updateScheduled(change);
  if (epoch === generation) accept(item);
}

export async function removeScheduledMessage(id: string, sendNow = false): Promise<void> {
  const epoch = generation;
  await (sendNow ? api.discord.sendScheduledNow(id) : api.discord.cancelScheduled(id));
  if (epoch !== generation) return;
  ++listRead;
  setLoading(false);
  setItems((all) => all.filter((m) => m.scheduled_message_id !== id));
}

onAppEvent('self-changed', () => {
  ++generation;
  ++listRead;
  setItems([]); setAvailability({}); setBusy({}); setNotices({}); setLoading(false); setListError(null);
  // Draft intent and uncertain creates survive an account event; clearing either could turn a retry into a fresh send.
  for (const channelId of monitored) void loadScheduledAvailability(channelId);
  if (monitored.size) void refreshScheduledMessages();
});
const restoredDrafts = Promise.all([
  idbEntries<boolean>(UNCERTAIN_KEY).then((saved) => {
    setUnconfirmed((u) => ({ ...Object.fromEntries(saved.map(([key]) => [key.slice(UNCERTAIN_KEY.length), true])), ...u }));
  }),
  idbEntries<string>(KEY).then((saved) => {
    setTimes((t) => ({ ...Object.fromEntries(saved.filter(([, value]) => Number.isFinite(Date.parse(value))).map(([key, value]) => [key.slice(KEY.length), value])), ...t }));
  }),
]);
