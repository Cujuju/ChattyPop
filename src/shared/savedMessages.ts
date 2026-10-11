// Discord owns one saved record per message: dueAt makes it a reminder, otherwise a bookmark.
import { SNOWFLAKE_ID, snowflakeArg } from './discord';
import { MS_PER_HOUR, MS_PER_MIN } from './units';

/** Native desktop bookmarks page size, verified in Discord's October 9, 2026 client. */
export const SAVED_BOOKMARK_PAGE_SIZE = 25;
export const SAVED_LIMIT_CODE = 30074;
/** Explicit retries are human recovery actions, capped at one per minute to prevent repeated refusal traffic. */
export const SAVED_REFRESH_INTERVAL_MS = MS_PER_MIN;
export const SAVED_SOURCES = ['context_menu', 'for_later_list'] as const;
export type SavedSource = (typeof SAVED_SOURCES)[number];

export interface SavedTarget { channelId: string; messageId: string }
export interface SavedMessage extends SavedTarget {
  guildId: string | null;
  savedAt: string;
  dueAt: string | null;
  authorName: string;
  /** Narrow author identity for the host's cached avatar route; never a media URL or raw Discord author. */
  author?: { id: string; avatar: string | null };
  channelName: string;
  summary: string;
  available: boolean;
}
export function savedAuthor(value: unknown): SavedMessage['author'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const author = value as Record<string, unknown>;
  if (typeof author.id !== 'string' || !SNOWFLAKE_ID.test(author.id)) return undefined;
  return { id: author.id, avatar: typeof author.avatar === 'string' && /^(?:a_)?[a-f\d]{32}$/.test(author.avatar) ? author.avatar : null };
}
export interface SavedStamp { session: string; revision: number }
export interface SavedIndex extends SavedStamp {
  pageEpoch: number;
  writableChannelIds: string[];
  reminders: SavedMessage[];
  bookmarkIds: string[];
  /** A native-compatible local list after a failed index read cannot establish remote emptiness. */
  indexReadFailed?: true;
  /** Older Discord clients return every saved message in the index itself. */
  legacyBookmarks?: SavedMessage[];
}
export interface SavedBookmarkPage extends SavedStamp {
  pageEpoch: number;
  bookmarks: SavedMessage[];
  hasMore: boolean;
  nextBefore: string | null;
}
export interface SavedPageRequest { session: string; pageEpoch?: number; before?: string; refresh?: boolean }
export interface SavedRemove extends SavedTarget { session: string; revision: number }
export interface SavedWrite extends SavedRemove { source: SavedSource; dueAt?: string }
export interface SavedVisible { items: SavedMessage[]; bookmarkIds: string[] }
/** Core's current read permission, intersected in main with the live gateway directory. */
export interface SavedChannelAccess { channelId: string; guildId: string | null; parentId: string | null; privateThread: boolean }

export const savedKey = (m: SavedTarget): string => `${m.channelId}/${m.messageId}`;
export function savedTarget(value: unknown): SavedTarget {
  if (!value || typeof value !== 'object') throw new Error('Not a saved-message target.');
  const v = value as Partial<SavedTarget>;
  return { channelId: snowflakeArg(v.channelId, 'channel'), messageId: snowflakeArg(v.messageId, 'message') };
}
/** Strict, canonical timestamps preserve Discord's save-time cursor without accepting arbitrary query values. */
export function savedTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('Not a saved-message timestamp.');
  if (new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('Not a saved-message calendar date.');
  return value;
}
/** Discord cursors can have six fractional digits; Date.parse alone loses their ordering. */
export function savedTimeOrder(value: string): bigint {
  const iso = savedTimestamp(value), fraction = /\.(\d+)/.exec(iso)?.[1] ?? '';
  return BigInt(Date.parse(iso)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
export function reminderTime(value: unknown, now = Date.now()): string {
  const iso = savedTimestamp(value);
  if (Date.parse(iso) <= now) throw new Error('Choose a reminder time in the future.');
  return new Date(iso).toISOString();
}

const REMINDER_HOUR = 9;
export const REMINDER_PRESETS = ['10m', '30m', '1h', '4h', 'morning', 'monday'] as const;
export type ReminderPreset = (typeof REMINDER_PRESETS)[number];
/** Calendar presets intentionally use local dates so DST does not turn 9am into 8am/10am. */
export function reminderPreset(preset: ReminderPreset, now = new Date()): Date {
  if (preset === '10m' || preset === '30m') return new Date(now.getTime() + (preset === '10m' ? 10 : 30) * MS_PER_MIN);
  if (preset === '1h' || preset === '4h') return new Date(now.getTime() + (preset === '1h' ? 1 : 4) * MS_PER_HOUR);
  const due = new Date(now);
  due.setHours(REMINDER_HOUR, 0, 0, 0);
  if (preset === 'morning') { if (due <= now) due.setDate(due.getDate() + 1); }
  else { const days = (8 - due.getDay()) % 7; due.setDate(due.getDate() + days); if (due <= now) due.setDate(due.getDate() + 7); }
  return due;
}
export function localReminderValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Refuses invalid calendar values and spring-forward times the browser would silently move to another hour. */
export function localReminderTime(value: string, now = Date.now()): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localReminderValue(date) !== value) throw new Error('That local time does not exist. Choose another time.');
  return reminderTime(date.toISOString(), now);
}
