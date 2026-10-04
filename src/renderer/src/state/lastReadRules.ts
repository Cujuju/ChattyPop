// When the Archive moves a channel's last-read mark, and what the "new messages" banner shows. Pure: tests import it.
import type { UnreadMark } from '@shared/contract';

/**
 * A view change's effect on the read mark. `start`: a channel came on screen; move the mark, show what was unread.
 * `advance`: new messages shown while watched; move it. `stop`: nothing watched. `none`: no change.
 */
export type WatchStep = 'start' | 'advance' | 'stop' | 'none';

/**
 * `watching`: the channel watched until now. `shown`: the channel on screen now, or null. `newest`: the newest message
 * the view shows, undefined while it shows an older stretch (a jump back), whose later messages are not seen.
 */
export function watchStep(watching: string | null, shown: string | null, newest: string | undefined): WatchStep {
  if (shown !== watching) return shown === null ? 'stop' : 'start';
  return shown !== null && newest !== undefined ? 'advance' : 'none';
}

/**
 * The banner after `channelId` comes on screen with `unread` (what arrived since the mark). A banner still up for the
 * same channel (window minimized and restored) keeps its first unread and adds the newer count.
 */
export function bannerAfterStart(banner: UnreadMark | null, unread: UnreadMark | null, channelId: string): UnreadMark | null {
  if (banner?.channelId !== channelId) return unread;
  return unread ? { ...banner, count: banner.count + unread.count } : banner;
}
