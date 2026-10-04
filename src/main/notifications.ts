// Host notification policy, independent of the desktop and push transports.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_NOTICE_KIND, type DeliveredNotification, type NotificationRequest } from '@shared/notifications';
import type { NoticeKind } from '@shared/notices';
import type { NotificationSettings } from '@shared/settings';

/** Delivery adapters; settings are read for each request, and phone choices are applied by the push transport. */
export interface NotificationDeps {
  settings(): Promise<{
    notifications: NotificationSettings;
  }>;
  desktop(request: DeliveredNotification): void;
  push(request: DeliveredNotification): void;
  /** Whether core chose or redacted notices of this kind under privacy mode (a plugin declares it on the kind). */
  privacyScoped(kind: NoticeKind): boolean;
  /** Whether notices about these channels are muted: there is one and every one is (core's allMuted). */
  muted(channelIds: readonly string[]): Promise<boolean>;
}

/** The host's notices; `live` is asked just before each transport sends, so a sender turned off meanwhile sends nothing. */
export interface HostNotifications {
  show(request: NotificationRequest, live?: () => Promise<boolean>): Promise<void>;
  /** Core reported privacy-changed: a privacy-scoped notice made before it is no longer sent. */
  privacyChanged(): void;
  /** Runs a core event's handler: notices it shows, even after awaits, count as made when that event arrived. */
  handling<T>(fn: () => T): T;
}

const always = (): Promise<boolean> => Promise.resolve(true);

/** Sends to the phone independently of the desktop switch, honoring request narrowing and muted places. */
export function notificationService(d: NotificationDeps): HostNotifications {
  /** Privacy changes seen so far; a notice remembers the count it was made under. */
  let privacyChanges = 0;
  const madeUnder = new AsyncLocalStorage<number>();
  return {
    show: async (request, live = always) => {
      const { aboutChannels, ...sent } = request;
      const notice = {
        ...sent,
        kind: request.kind ?? DEFAULT_NOTICE_KIND,
      };
      const madeAt = madeUnder.getStore() ?? privacyChanges;
      // Core chose (or redacted) a scoped notice under privacy mode as it was then: send it only while that holds.
      const sendable = async (): Promise<boolean> =>
        (await live()) && (!d.privacyScoped(notice.kind) || privacyChanges === madeAt);
      if (!(await sendable())) return;
      const settings = await d.settings();
      const target = request.target;
      if (target?.kind === 'message' && (await d.muted([target.channelId]))) return;
      if (aboutChannels?.length && (await d.muted(aboutChannels))) return;
      // Checked again after those reads: a sender turned off (or privacy changed) meanwhile sends nothing.
      if (!(await sendable())) return;
      if (request.phone !== false) d.push(notice);
      if (!settings.notifications.desktop || request.desktop === false) return;
      d.desktop(notice);
    },
    privacyChanged: () => {
      privacyChanges++;
    },
    handling: (fn) => madeUnder.run(privacyChanges, fn),
  };
}
