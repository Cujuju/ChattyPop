// The Archive's last-read marks: moved while a channel is on screen, and the "new messages since" banner on opening one.
import { api } from '@/api';
import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';
import type { UnreadMark } from '@shared/contract';
import { archiveChannelId, archiveState, atNewest } from './archive';
import { refetchDirectory } from './directory';
import { bannerAfterStart, watchStep } from './lastReadRules';

const [banner, setBanner] = createSignal<UnreadMark | null>(null);
/** What was unread in the Archive's channel when it came on screen; null when nothing was, or once dismissed. */
export const unreadBanner = (): UnreadMark | null => {
  const b = banner();
  return b?.channelId === archiveChannelId() ? b : null;
};
export const dismissUnreadBanner = (): void => void setBanner(null);

/** Moves the mark to now; returns what was unread before. The sidebar's new count resets when anything was. */
async function markViewed(channelId: string): Promise<UnreadMark | null> {
  const unread = await api.core.markChannelViewed(channelId);
  if (unread) void refetchDirectory();
  return unread;
}

/**
 * Keeps the open channel's mark current while the Archive is `shown`: messages that arrive while watched are never new.
 * Call from the Archive view's body; stops (and drops the banner) with its owner.
 */
export function watchArchive(shown: Accessor<boolean>): void {
  let watching: string | null = null;
  // Tracked so the mark moves as messages arrive; a window scrolled far back doesn't show the newest ones.
  const newest = createMemo(() => (atNewest() ? archiveState.items.at(-1)?.id : undefined));
  createEffect(() => {
    const channelId = shown() ? archiveChannelId() : null;
    const step = watchStep(watching, channelId, newest());
    watching = channelId;
    if (step === 'advance' && channelId) void markViewed(channelId);
    if (step !== 'start' || !channelId) return;
    if (untrack(banner)?.channelId !== channelId) setBanner(null);
    void markViewed(channelId).then((unread) => {
      if (watching === channelId) setBanner((b) => bannerAfterStart(b, unread, channelId));
    });
  });
  onCleanup(dismissUnreadBanner);
}
