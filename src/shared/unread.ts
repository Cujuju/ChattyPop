// Reactive unread sources shared by host and bundled renderer contributions, and the per-kind totals the taskbar and
// tray indicators show.
import { isObj } from './normalize';
import type { DirectoryGuild } from './types/archive';

/** What a counted unread source is, so the taskbar and tray can tell them apart: Discord chat, or alerts. */
export type UnreadKind = 'chat' | 'alerts';
export const UNREAD_KINDS: readonly UnreadKind[] = ['chat', 'alerts'];
/** A source that names no kind: every plugin source so far counts notifications (Alerts), not chat. */
export const DEFAULT_UNREAD_KIND: UnreadKind = 'alerts';

/** Unread counts summed per kind. */
export type UnreadTotals = Record<UnreadKind, number>;
export const NO_UNREAD: UnreadTotals = { chat: 0, alerts: 0 };

/** What a panel has that the user hasn't seen (state/unread.ts). */
export interface UnreadSource {
  count: () => number;
  /** Clears it while the panel is on screen. Absent when reading is an explicit act (opening an alert). */
  markSeen?: () => void;
  /** Runs each time the panel comes on screen, before markSeen. */
  onShown?: () => void;
  /** For a counted source (frame `unread`), which total it joins; absent = DEFAULT_UNREAD_KIND. */
  kind?: UnreadKind;
}

/**
 * Discord's own unread badge count: read-state mention counts summed (every unread DM message, each ping in a server
 * channel), message requests left out as Discord leaves them out. Muted DMs carry no count.
 */
export const chatUnreadCount = (guilds: readonly DirectoryGuild[]): number =>
  guilds.reduce((sum, g) => sum + g.channels.reduce((n, c) => n + (c.dm?.request ? 0 : c.mentionCount), 0), 0);

/** Each kind's noun, singular and plural. */
const NOUNS: Record<UnreadKind, { one: string; many: string }> = { chat: { one: 'message', many: 'messages' }, alerts: { one: 'alert', many: 'alerts' } };

/** The kinds unread, as the tray tooltip and taskbar overlay say them ("3 messages, 1 alert"); null when none is. */
export function unreadSummary(unread: UnreadTotals): string | null {
  const parts = UNREAD_KINDS.filter((k) => unread[k] > 0).map((k) => `${unread[k]} ${unread[k] === 1 ? NOUNS[k].one : NOUNS[k].many}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** `v` as unread totals: each kind a nonnegative integer, else 0. */
export function normalizeUnreadTotals(v: unknown): UnreadTotals {
  const o = isObj(v) ? v : {};
  const count = (n: unknown): number => (Number.isInteger(n) ? Math.max(0, n as number) : 0);
  return { chat: count(o['chat']), alerts: count(o['alerts']) };
}
