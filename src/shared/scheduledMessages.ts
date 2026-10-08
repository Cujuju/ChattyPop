// Discord's server-side scheduled sends; times are local in pickers and ISO on the wire.
import type { OwnerMessage } from './compose';
import { snowflakeToMs, type RawMessage } from './discord';
import { MS_PER_DAY, MS_PER_MIN } from './units';

export const SCHEDULE_MIN_MS = 10 * MS_PER_MIN;
export const SCHEDULE_MAX_MS = 8 * MS_PER_DAY;
export const SCHEDULE_REPLY_MAX_MS = 30 * MS_PER_DAY;
export const SUPPRESS_NOTIFICATIONS = 1 << 12;
export const SCHEDULE_LIMIT_CODE = 640003;
export const SCHEDULE_UNCONFIRMED = 'Scheduling was not confirmed. Check scheduled messages before trying again.';

export interface ScheduledAvailability {
  enabled: boolean;
  limit: number;
}

export interface ScheduledDraft extends OwnerMessage {
  scheduledTimestamp: string;
}

export interface ScheduledMessage {
  user_id: string;
  scheduled_message_id: string;
  send_at_timestamp: string;
  create_args: {
    channel_id: string;
    content: string;
    type: number;
    flags: number;
    message_reference?: { channel_id?: string; message_id?: string };
  };
  state: number;
  attachment_uploads?: { filename: string; uploaded_filename: string; description?: string; title?: string }[];
  message_preview?: Partial<RawMessage> & { sticker_items?: { id: string }[]; poll?: unknown };
}

export interface ScheduledUpdate {
  id: string;
  scheduledTimestamp?: string;
  content?: string;
  flags?: number;
}

export function scheduleWindowError(at: number, now = Date.now(), replyId?: string | null): string | null {
  if (!Number.isFinite(at)) return 'Choose a valid date and time.';
  if (at < now + SCHEDULE_MIN_MS) return 'Too soon: choose at least 10 minutes from now.';
  const end = Math.min(now + SCHEDULE_MAX_MS, replyId ? snowflakeToMs(replyId) + SCHEDULE_REPLY_MAX_MS : Infinity);
  if (at > end) return replyId && end < now + SCHEDULE_MAX_MS
    ? 'Too far: replies must be sent within 30 days of the original message.'
    : 'Too far: choose within the next 8 days.';
  return null;
}

/** Next ISO-week Monday, including when today is Monday. Matches the client's startOf(isoWeek) + week. */
export function schedulePresets(now = Date.now()): { label: string; timestamp: string }[] {
  const soonest = now + SCHEDULE_MIN_MS;
  const times = [9, 13].map((hour) => {
    const date = new Date(now);
    date.setHours(hour, 0, 0, 0);
    const tomorrow = date.getTime() <= soonest;
    if (tomorrow) date.setDate(date.getDate() + 1);
    return { label: `${tomorrow ? 'Tomorrow' : 'Today'} ${hour === 9 ? '9 AM' : '1 PM'}`, timestamp: date.toISOString() };
  });
  const monday = new Date(now);
  monday.setDate(monday.getDate() + (8 - (monday.getDay() || 7)));
  monday.setHours(9, 0, 0, 0);
  return [...times, { label: 'Next Monday 9 AM', timestamp: monday.toISOString() }];
}

export function defaultScheduleTime(now = Date.now()): string {
  const date = new Date(now);
  date.setHours(date.getHours() + 1, 0, 0, 0);
  if (date.getTime() < now + SCHEDULE_MIN_MS) date.setHours(date.getHours() + 1);
  return date.toISOString();
}

export const scheduledStateLabel = (state: number): string => [
  'Scheduled', 'Scheduled messages disabled', 'User not found', 'Scheduling unavailable for this account',
  'Channel not found', 'Send failed',
][state] ?? 'Unknown scheduling state';

/** The client's silent-prefix parser treats it as a leading token. */
export function scheduledContent(content: string, flags = 0): { content: string; flags: number } {
  const silent = /^@silent(?:\s+|$)/.exec(content);
  return silent ? { content: content.slice('@silent'.length).trim(), flags: flags | SUPPRESS_NOTIFICATIONS } : { content, flags };
}
