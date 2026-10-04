// Desktop toasts: the host notification service's desktop transport (notifications.ts decides whether one shows).
import { Notification, type BrowserWindow } from 'electron';
import type { AppEvent } from '@shared/contract';
import type { Notice } from '@shared/notices';
import type { DeliveredNotification } from '@shared/notifications';
import { diag } from './diagnostics';
import { raiseWindow } from './windowState';

/** Shows a toast and records whether Windows displayed it (the only proof a toast actually appeared). */
function show(n: Notification, kind: Notice['kind']): void {
  n.on('show', () => diag('toast-shown', { kind }));
  n.on('failed', (_e, error) => diag('toast-failed', { kind, error }));
  n.on('click', () => diag('toast-clicked', { kind }));
  n.show();
}

/** Shows one toast. A click brings the window up at its target: the message, or the panel, it names. */
export function notifyDesktop(
  win: BrowserWindow,
  notice: DeliveredNotification,
  toMain: (e: AppEvent) => void,
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: notice.title,
    body: notice.body,
  });
  n.on('click', () => {
    if (!raiseWindow(win)) return;
    const target = notice.target;
    if (target?.kind === 'message') toMain({
      type: 'open-message',
      channelId: target.channelId,
      messageId: target.messageId,
    });
    if (target?.kind === 'panel') toMain({
      type: 'open-panel',
      panelId: target.panelId,
    });
  });
  show(n, notice.kind);
}
