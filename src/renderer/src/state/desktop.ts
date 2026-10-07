// Settings → Desktop's state, kept by main, and the main window's unread totals for the taskbar and tray indicators.
import { createEffect } from 'solid-js';
import { SPLASH_THEME_TOKENS } from '@shared/splash.mjs';
import { api } from '@/api';
import type { DesktopSettings } from '@shared/desktop';
import { createPushedValue } from './events';
import { themeApplied } from './preferences';
import { unreadTotals } from './unreadCounts';

const pushed = createPushedValue(() => api.desktop.state(), 'desktop-changed', (e) => e.state);
/** Main's desktop state; null while loading. Reactive. */
export const desktopState = pushed.value;

export const patchDesktopSettings = (patch: Partial<DesktopSettings>): Promise<void> => api.desktop.set(patch);

/** Keeps the taskbar and tray indicators on the unread totals per kind. Call once, from the main window's root. */
export function syncUnreadBadge(): void {
  createEffect(() => void api.desktop.setBadge(unreadTotals()));
}

/** Saves the theme's splash tokens as resolved each time a theme is worn, so the next start's splash wears it. Call once, from the main window's root. */
export function syncSplashTheme(): void {
  createEffect(() => {
    themeApplied();
    const style = getComputedStyle(document.documentElement);
    void api.desktop.setSplashTheme(Object.fromEntries(SPLASH_THEME_TOKENS.map((t) => [t, style.getPropertyValue(t).trim()])));
  });
}
