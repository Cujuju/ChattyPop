// The Archive's last-read marks: moved to the newest message the owner sees, and the "new messages since" banner.
import { api } from '@/api';
import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';
import type { UnreadBoundary, UnreadMark } from '@shared/contract';
import { SETTINGS_KEYS } from '@shared/settings';
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

/** Marks newest visible messages only when lookable and opening unread snapshot is ready. Banner preserves opening counts; owner disposal stops tracking. */
export function watchArchive(lookable: Accessor<boolean>, seen: Accessor<string | undefined>): void {
  /** The channel whose banner is in: marking may start. */
  const [ready, setReady] = createSignal<string | null>(null);
  /** Bumped by each banner read (snapshot or reconcile) and on cleanup: only the latest one's answer lands. */
  let requests = 0;
  /** The last message marked, or being marked. */
  let marked: string | undefined;
  /** The mark had reached the newest loaded message when the view was last put away. */
  let caughtUp = false;
  /** All unread messages at opening, before bot filtering; remains valid after this view marks them read. */
  let boundary: UnreadBoundary | null = null;
  let openingDismissal = dismissals;
  /** Bumped when the desktop is reachable again: a mark that failed goes again. */
  const [retries, setRetries] = createSignal(0);

  /** Reads what is unread now as the banner, holding marking until it is in. */
  const snapshot = (channelId: string): void => {
    const request = ++requests;
    const dismissed = dismissals;
    setReady(null);
    boundary = null;
    void api.core.channelUnreadSnapshot(channelId).then(
      (snapshot) => {
        if (request !== requests) return;
        boundary = snapshot.boundary;
        openingDismissal = dismissed;
        if (dismissed === dismissals) setBanner(snapshot.unread);
        setReady(channelId);
      },
      // No banner, but reading still moves the mark.
      () => void (request === requests && setReady(channelId)),
    );
  };

  /** Reloads banners from opening boundaries, excluding external reads and owner messages. Pending opening snapshots are retaken after changes. */
  const reconcile = (): void => {
    const channelId = archiveChannelId();
    if (!channelId) return;
    if (untrack(ready) !== channelId) return snapshot(channelId);
    if (!boundary || openingDismissal !== dismissals) return;
    const request = ++requests;
    const dismissed = dismissals;
    void api.core.channelUnread(channelId, boundary, marked).then((unread) => {
      if (request === requests && dismissed === dismissals) setBanner(unread);
    }, () => undefined);
  };

  createEffect(
    on(archiveChannelId, (channelId) => {
      requests++;
      boundary = null;
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
    onAppEvent('setting-changed', (e) => {
      if (e.key === SETTINGS_KEYS.countedBots) reconcile();
    }),
    // External reads/owner sends advance Discord state beyond local marks. Local acknowledgment echoes preserve the banner.
    onAppEvent('read-states-changed', (e) => {
      const s = e.states.find((c) => c.channelId === archiveChannelId());
      if (s?.ackId && (marked === undefined || compareSnowflakes(s.ackId, marked) > 0)) {
        // An external read stays external after this view catches up; policy changes must never resurrect it.
        if (boundary && (!boundary.ackId || compareSnowflakes(s.ackId, boundary.ackId) > 0)) boundary = { ...boundary, ackId: s.ackId };
        reconcile();
      }
    }),
  ];
  onCleanup(() => {
    requests++;
    window.removeEventListener(DESKTOP_CONNECTED_EVENT, retry);
    for (const off of offs) off();
    setBanner(null);
  });
}
