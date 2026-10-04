// The Archive's last-read marks: moved to the newest message the owner sees, and the "new messages since" banner on opening one.
import { api } from '@/api';
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';
import type { UnreadMark } from '@shared/contract';
import { archiveChannelId } from './archive';
import { bannerAfterStart, messageToMark, watchStep } from './lastReadRules';

const [banner, setBanner] = createSignal<UnreadMark | null>(null);
/** Bumped by each dismissal: a banner requested before it doesn't show. */
let dismissals = 0;
/** What was unread in the Archive's channel when it came on screen; null when nothing was, or once dismissed. */
export const unreadBanner = (): UnreadMark | null => {
  const b = banner();
  return b?.channelId === archiveChannelId() ? b : null;
};
export const dismissUnreadBanner = (): void => {
  dismissals++;
  setBanner(null);
};

/**
 * Keeps the open channel's mark at the newest message the owner has seen while the Archive is `shown`. `seen`: that
 * message's id, undefined while none is in view (an open loading, scrolled up, a jump back). On coming on screen the
 * banner reads what is unread first; marking waits for it. Call from the Archive view's body; stops with its owner.
 */
export function watchArchive(shown: Accessor<boolean>, seen: Accessor<string | undefined>): void {
  let watching: string | null = null;
  /** Bumped by each start and stop: an answer to an older one is dropped. */
  let starts = 0;
  /** The channel whose banner is in: marking may start. */
  const [ready, setReady] = createSignal<string | null>(null);
  let marked: string | undefined;
  createEffect(() => {
    const channelId = shown() ? archiveChannelId() : null;
    const step = watchStep(watching, channelId);
    watching = channelId;
    if (step === 'none') return;
    setReady(null);
    marked = undefined;
    const start = ++starts;
    if (step === 'stop' || !channelId) return;
    if (untrack(banner)?.channelId !== channelId) setBanner(null);
    const dismissed = dismissals;
    void api.core.channelUnread(channelId).then(
      (unread) => {
        if (start !== starts) return;
        if (dismissed === dismissals) setBanner((b) => bannerAfterStart(b, unread, channelId));
        setReady(channelId);
      },
      // No banner, but reading still moves the mark.
      () => void (start === starts && setReady(channelId)),
    );
  });
  createEffect(() => {
    const channelId = watching === archiveChannelId() ? watching : null;
    const id = messageToMark(channelId, ready(), seen(), marked);
    if (!channelId || !id) return;
    marked = id;
    void api.core.markChannelRead(channelId, id);
  });
  onCleanup(() => {
    starts++;
    watching = null;
    dismissUnreadBanner();
  });
}
