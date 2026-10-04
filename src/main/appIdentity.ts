// What the app says about itself: its version to Electron, and to every site (Discord above all) only the bundled Chromium's user agent.
import { app } from 'electron';

declare global {
  namespace Electron {
    interface App {
      /** Internal: Electron's own dev loader (default_app) sets the version from package.json this way. */
      setVersion(version: string): void;
    }
  }
}

/** The span Electron widens with `<app name>/<version>` and `Electron/<version>` tokens. */
const PRODUCT_SPAN = /\(KHTML, like Gecko\) .* Safari\//;

/** Chromium's reduced user agent: no app or Electron tokens, Chrome version frozen to `<major>.0.0.0` as the browser sends it. */
export function browserUserAgent(electronUa: string, chromeVersion: string): string {
  if (!PRODUCT_SPAN.test(electronUa)) throw new Error(`Unrecognized user agent; refusing to send it: ${electronUa}`);
  const major = chromeVersion.split('.')[0];
  return electronUa.replace(PRODUCT_SPAN, `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/`);
}

/** Call before any session or window exists: a session takes the fallback user agent when it is created. */
export function applyAppIdentity(): void {
  // Dev loads package.json, which has no version; packaged builds carry it (electron-builder.ts).
  if (!app.isPackaged) app.setVersion(__APP_VERSION__);
  app.userAgentFallback = browserUserAgent(app.userAgentFallback, process.versions.chrome);
}
