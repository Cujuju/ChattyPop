// Core event routing to windows, the phone and main-process services.
import type { BrowserWindow } from 'electron';
import { channelAudiences, privacyScopedNotice } from '@shared/bundledPlugins';
import { APP_EVENT_CHANNEL, sharedEvent, type AppEvent } from '@shared/contract';
import { SETTINGS_KEYS, normalizeNotificationSettings } from '@shared/settings';
import { notifyDesktop } from './desktopNotifications';
import { noticesFor } from '@shared/notices';
import { notificationRequest, type DeliveredNotification } from '@shared/notifications';
import { notificationService, type HostNotifications } from './notifications';
import { diag } from './diagnostics';
import { errorMessage } from '@shared/errors';
import type { CoreClient } from './coreClient';
import type { AttachmentDownloader } from './media/attachmentDownloader';
import type { PanelWindows } from './panelWindows';

export interface CoreEventDeps {
  win: BrowserWindow;
  panelWindows: PanelWindows;
  core: CoreClient;
  downloader: AttachmentDownloader;
  /** The phone's transport, when one is connected (main/phone/hub.ts). */
  phone: {
    broadcast(e: AppEvent): void;
    notify(request: DeliveredNotification): void;
  };
}

export interface EventSinks {
  notifications: HostNotifications;
  /** Every window. */
  toRenderer(e: AppEvent): void;
  /** Commands for the main window alone (opening a message), so panel windows never act on them. */
  toMain(e: AppEvent): void;
  /** A plugin event to the windows and the phone its audiences name (main's own go to plugins/bundled.ts). */
  publish(e: AppEvent): void;
}

/** Forwards core's events to the windows and acts on those meant for main (downloads, toasts, live tags). */
export function routeCoreEvents(d: CoreEventDeps): EventSinks {
  const { win, core } = d;
  // Panel windows and the phone run their own copy of the stores, so they get every event too.
  const toRenderer = (e: AppEvent): void => {
    for (const w of [win, ...d.panelWindows.windows()]) if (!w.isDestroyed()) w.webContents.send(APP_EVENT_CHANNEL, e);
    d.phone.broadcast(e);
  };
  const toMain = (e: AppEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(APP_EVENT_CHANNEL, e);
  };
  const notifications = notificationService({
    settings: async () => {
      // Read per delivery, so Settings changes apply at once.
      return { notifications: normalizeNotificationSettings(await core.call('getSetting', SETTINGS_KEYS.notifications)) };
    },
    desktop: (request) => notifyDesktop(win, request, toMain),
    push: (request) => d.phone.notify(request),
    privacyScoped: privacyScopedNotice,
    muted: (channelIds) => core.call('allMuted', channelIds),
  });
  // A plugin event goes to windows only when its audiences include them; the phone's hub filters the phone's.
  const publish = (event: AppEvent): void => {
    const e = sharedEvent(event);
    if (e.type !== 'plugin-event' || channelAudiences(e.pluginId, 'events', e.name).includes('renderer')) toRenderer(e);
    else d.phone.broadcast(e);
  };
  core.on('event', publish);
  core.on('event', (e) => {
    if (e.type === 'privacy-changed') notifications.privacyChanged();
    if (e.type === 'archive-changed') d.downloader.kick();
    for (const notice of noticesFor(e)) {
      void notifications.show(notificationRequest(notice)).catch((error: unknown) => {
        diag('notification-failed', { message: errorMessage(error) });
      });
    }
  });
  return {
    toRenderer,
    toMain,
    publish,
    notifications,
  };
}
