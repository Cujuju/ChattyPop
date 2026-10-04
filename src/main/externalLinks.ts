import { shell, type WebContents } from 'electron';

/** Opens http(s) URLs in the system browser; anything else is dropped. */
export const openExternally = (url: string): void => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

/**
 * Keeps `wc` on pages `allow` accepts: new windows and other navigations open in the system browser instead.
 * A throwing `allow` (a malformed URL) counts as not allowed.
 */
export function guardNavigation(wc: WebContents, allow: (url: string) => boolean): void {
  wc.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    try {
      if (allow(url)) return;
    } catch {
      // Not allowed: handled below.
    }
    event.preventDefault();
    openExternally(url);
  });
}
