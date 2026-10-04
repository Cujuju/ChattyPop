// Settings → Desktop's state, kept by main, and the main window's unread totals for the taskbar and tray indicators.
import { createEffect } from 'solid-js';
import { api } from '@/api';
import type { DesktopSettings } from '@shared/desktop';
import { createPushedValue } from './events';
import { unreadTotals } from './unreadCounts';

const pushed = createPushedValue(() => api.desktop.state(), 'desktop-changed', (e) => e.state);
/** Main's desktop state; null while loading. Reactive. */
export const desktopState = pushed.value;

export const patchDesktopSettings = (patch: Partial<DesktopSettings>): Promise<void> => api.desktop.set(patch);

/** Keeps the taskbar and tray indicators on the unread totals per kind. Call once, from the main window's root. */
export function syncUnreadBadge(): void {
  createEffect(() => void api.desktop.setBadge(unreadTotals()));
}
