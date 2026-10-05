// The Archive's last-read marks: moved to the newest message the owner sees, and the "new messages since" banner.
import { api } from '@/api';
import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';
import type { UnreadMark } from '@shared/contract';
import { compareSnowflakes } from '@shared/discord';
import { DESKTOP_CONNECTED_EVENT } from '@shared/phone';
import { archiveChannelId, archiveState } from './archive';
import { onAppEvent } from './events';
import { messageToMark } from './lastReadRules';
import { listen } from '@/ui/listen';

const [banner, setBanner] = createSignal<UnreadMark | null>(null);
/** Bumped by each dismissal: a banner requested before it doesn't show. */
let dismissals = 0;
/** What was unread in the Archive's channel when it was opened (or returned to); null when nothing was, or once dismissed. */
export const unreadBanner = (): UnreadMark | null => {
  const b = banner();
  return b?.channelId === archiveChannelId() ? b : null;
};
export const dismissUnreadBanner = (): void => {
  dismissals++;
  setBanner(null);
};

/**
 * Keeps the open channel's mark at the newest message the owner has seen. `lookable`: the owner can look at the Archive
 * now. `seen`: the newest message on screen, undefined while none is in view (an open loading, scrolled up, a jump back).
 * The banner is what was unread when the channel was opened, or returned to after reading up to its newest; marking
 * waits for it, so it never counts what this view already marked. Call from the Archive view's body; stops with its owner.
 */
export function watchArchive(lookable: Accessor<boolean>, seen: Accessor<string | undefined>): void {
  /** The channel whose banner is in: marking may start. */
  const [ready, setReady] = createSignal<string | null>(null);
  /** Bumped by each banner read (snapshot or reconcile) and on cleanup: only the latest one's answer lands. */
  let requests = 0;
  /** The last message marked, or being marked. */
  let marked: string | undefined;
  /** The mark had reached the newest loaded message when the view was last put away. */
  let caughtUp = false;
  /** Bumped when the desktop is reachable again: a mark that failed goes again. */
  const [retries, setRetries] = createSignal(0);

  /** Reads what is unread now as the banner, holding marking until it is in. */
  const snapshot = (channelId: string): void => {
    const request = ++requests;
    const dismissed = dismissals;
    setReady(null);
    void api.core.channelUnread(channelId).then(
      (unread) => {
        if (request !== requests) return;
        if (dismissed === dismissals) setBanner(unread);
        setReady(channelId);
      },
      // No banner, but reading still moves the mark.
      () => void (request === requests && setReady(channelId)),
    );
  };

  /**
   * The banner read again from its first unread, leaving out what was read elsewhere or sent by the owner since. While
   * the opening snapshot is still out, it is taken again instead: its answer may predate the change.
   */
  const reconcile = (): void => {
    const channelId = archiveChannelId();
    if (!channelId) return;
    if (untrack(ready) !== channelId) return snapshot(channelId);
    const b = untrack(banner);
    if (!b || b.channelId !== channelId) return;
    const request = ++requests;
    const dismissed = dismissals;
    void api.core.channelUnread(channelId, b.firstId).then((unread) => {
      if (request === requests && dismissed === dismissals) setBanner(unread);
    }, () => undefined);
  };

  createEffect(
    on(archiveChannelId, (channelId) => {
      marked = undefined;
      caughtUp = false;
      setBanner(null);
      if (channelId) snapshot(channelId);
      else setReady(null);
    }),
  );

  // Away and back (another window, an overlay): a banner for what came meanwhile, when everything before was read.
  createEffect(
    on(lookable, (now, was) => {
      const channelId = archiveChannelId();
      if (!channelId || ready() !== channelId) return;
      if (!now) caughtUp = marked !== undefined && marked === untrack(() => archiveState.items.at(-1)?.id);
      else if (was === false && caughtUp && !untrack(banner)) snapshot(channelId);
    }),
  );

  createEffect(() => {
    retries();
    const channelId = archiveChannelId();
    const id = lookable() ? messageToMark(channelId, ready(), seen(), marked) : undefined;
    if (!channelId || !id) return;
    marked = id;
    // Failed: the next change (or a reconnect) marks it again.
    api.core.markChannelRead(channelId, id).catch(() => void (marked === id && (marked = undefined)));
  });

  const retry = (): void => void setRetries((n) => n + 1);
  listen(window, 'online', retry);
  window.addEventListener(DESKTOP_CONNECTED_EVENT, retry);
  const offs = [
    onAppEvent('self-changed', reconcile),
    // Discord's read state moved past what this view marked: a read in another client, or the owner's message. The
    // echo of this view's own reads leaves the banner, as reading here does.
    onAppEvent('read-states-changed', (e) => {
      const s = e.states.find((c) => c.channelId === archiveChannelId());
      if (s?.ackId && (marked === undefined || compareSnowflakes(s.ackId, marked) > 0)) reconcile();
    }),
  ];
  onCleanup(() => {
    requests++;
    window.removeEventListener(DESKTOP_CONNECTED_EVENT, retry);
    for (const off of offs) off();
    setBanner(null);
  });
}
