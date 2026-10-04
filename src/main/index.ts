// Main's boot entry (docs/plugin-architecture.md §16). Synchronously, before app 'ready': the app identity and profile,
// custom schemes and Chromium switches; then installed plugins are decided, and only then is the app imported, since
// its plugin registry lists what that decides. Nothing that must precede 'ready' may follow the import.
import { app } from 'electron';
import { INSTALLED_ENV, INSTALLED_PLUGINS_DIR, type InstalledStart } from '@shared/installedPlugins';
import { errorMessage } from '@shared/errors';
import { BYTES_PER_MB } from '@shared/units';
import { applyAppIdentity } from './appIdentity';
import { diag } from './diagnostics';
import { registerMediaScheme } from './media/mediaProtocol';
import { prepareInstalled } from './plugins/installed/boot';
import { encodeInstalledStart } from './plugins/installed/runtime';
import { INSTALLED_SCHEME_PRIVILEGES, PLUGIN_SCHEME_PRIVILEGES } from './pluginProtocol';
import { applyProfileDirOverride, profilePath } from './storageLocation';

/** Custom schemes registered beside the media scheme; Electron takes privileged schemes once, before 'ready'. */
const SCHEME_PRIVILEGES = [PLUGIN_SCHEME_PRIVILEGES, INSTALLED_SCHEME_PRIVILEGES];
/** Chromium's HTTP cache (mostly the embedded Discord client) lives in the app profile, by default on the system drive; keep it small. */
const HTTP_CACHE_MAX_BYTES = 64 * BYTES_PER_MB;

applyAppIdentity();
applyProfileDirOverride();
registerMediaScheme(SCHEME_PRIVILEGES);
app.commandLine.appendSwitch('disk-cache-size', String(HTTP_CACHE_MAX_BYTES));

/** This start's installed plugins; none when deciding fails outright, so the app still starts. */
function decideInstalled(): InstalledStart {
  try {
    return prepareInstalled(profilePath(INSTALLED_PLUGINS_DIR), diag);
  } catch (err) {
    diag('installed-plugins-failed', { message: errorMessage(err) });
    return { accepted: [], refused: [] };
  }
}
// One process per profile: a second would apply staged changes and clear install work under the running one. The
// running one raises its window instead (app.ts); this one has opened nothing, so it quits.
if (app.requestSingleInstanceLock()) {
  // Core inherits it (CoreClient), so both processes load the same plugins.
  process.env[INSTALLED_ENV] = encodeInstalledStart(profilePath(INSTALLED_PLUGINS_DIR), decideInstalled());
  await import('./app');
} else {
  app.quit();
}
