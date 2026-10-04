// When the Archive moves a channel's last-read mark, and what the "new messages" banner shows. Pure: tests import it.
import type { UnreadMark } from '@shared/contract';

/** A view change's effect. `start`: a channel came on screen; show what was unread. `stop`: nothing watched. `none`: no change. */
export type WatchStep = 'start' | 'stop' | 'none';

/** `watching`: the channel watched until now. `shown`: the channel on screen now, or null. */
export function watchStep(watching: string | null, shown: string | null): WatchStep {
  if (shown === watching) return 'none';
  return shown === null ? 'stop' : 'start';
}

/**
 * The message to mark read: `seen`, the newest message on screen, once the banner for `ready` (the channel whose
 * unread was read on coming on screen) is in, so marking never hides what the banner should count. Undefined when
 * there is nothing to mark, or it was marked already (`marked`).
 */
export function messageToMark(channelId: string | null, ready: string | null, seen: string | undefined, marked: string | undefined): string | undefined {
  return channelId !== null && channelId === ready && seen !== undefined && seen !== marked ? seen : undefined;
}

/**
 * The banner after `channelId` comes on screen with `unread` (what arrived since the mark). A banner still up for the
 * same channel (window minimized and restored) keeps its first unread and adds the newer count.
 */
export function bannerAfterStart(banner: UnreadMark | null, unread: UnreadMark | null, channelId: string): UnreadMark | null {
  if (banner?.channelId !== channelId) return unread;
  return unread ? { ...banner, count: banner.count + unread.count } : banner;
}
