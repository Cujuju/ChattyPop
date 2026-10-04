// Notification delivery requests shared by main, plugins and the companion.
import type { Notice, NoticeKind } from './notices';

/** What a notification click opens; null raises the app without navigating. */
export type NotificationTarget =
  | {
    kind: 'message';
    channelId: string;
    messageId: string;
  }
  | {
    kind: 'panel';
    panelId: string;
  }
  | null;

/** Delivery text and destination; kind selects the phone's subscription preference (a plugin names its own, `K`). */
export interface NotificationRequest<K extends string = NoticeKind> {
  title: string;
  body: string;
  target: NotificationTarget;
  kind?: K;
  /** False narrows delivery to paired phones; omission follows the global desktop switch. */
  desktop?: false;
  /** False keeps it off paired phones; omission sends it to each phone that chose its kind. */
  phone?: false;
  /** Channels the notice reports on beyond its target (a summary's); it reaches no device when every one is muted. */
  aboutChannels?: readonly string[];
}

/** A plugin's notification without a kind is filed under the phone's "Plugin notifications" choice. */
export const DEFAULT_NOTICE_KIND: NoticeKind = 'plugin';

/** A request as the transports get it: its kind settled by the service. */
export type DeliveredNotification = Omit<NotificationRequest, 'aboutChannels'> & { kind: NoticeKind };

/** Main's settings-aware delivery service, for a plugin whose declared notice kinds are `K`. */
export interface Notifications<K extends string = NoticeKind> {
  show(request: NotificationRequest<K>): Promise<void>;
}

/** Adapts today's host notices without changing their text or click destination. */
export const notificationRequest = <K extends string>(notice: Notice<K>): NotificationRequest<K> => ({
  title: notice.title,
  body: notice.body,
  kind: notice.kind,
  target: notice.open ? {
    kind: 'message',
    ...notice.open,
  } : null,
});
