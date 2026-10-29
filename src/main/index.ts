// Boot establishes identity/profile, schemes and Chromium switches before ready. Decides installed plugins before importing the app and plugin registry.
// A client (--connect) has its own profile and none of that: it starts the client instead.
import { app } from 'electron';
import { INSTALLED_ENV, INSTALLED_PLUGINS_DIR } from '@shared/installedPlugins';
import { BYTES_PER_MB } from '@shared/units';
import { applyAppIdentity } from './appIdentity';
import { applyClientProfile } from './client/profile';
import { launchMode } from './launchMode';
import { diag } from './diagnostics';
import { applyOsHourCycle } from './osClock';
import { registerMediaScheme } from './media/mediaProtocol';
import { prepareInstalled } from './plugins/installed/boot';
import { encodeInstalledStart } from './plugins/installed/runtime';
import { INSTALLED_SCHEME_PRIVILEGES, PLUGIN_SCHEME_PRIVILEGES } from './pluginProtocol';
import { applyShellPath } from './shellPath';
import { applyProfileDirOverride, profilePath } from './storageLocation';

/** Custom schemes registered beside the media scheme; Electron takes privileged schemes once, before 'ready'. */
const SCHEME_PRIVILEGES = [PLUGIN_SCHEME_PRIVILEGES, INSTALLED_SCHEME_PRIVILEGES];
/** Chromium's HTTP cache (mostly the embedded Discord client) lives in the app profile, by default on the system drive; keep it small. */
const HTTP_CACHE_MAX_BYTES = 64 * BYTES_PER_MB;

applyAppIdentity();
applyOsHourCycle();
app.commandLine.appendSwitch('disk-cache-size', String(HTTP_CACHE_MAX_BYTES));
const client = launchMode(process.argv, process.env).kind === 'client';
if (client) applyClientProfile();
else {
  applyProfileDirOverride();
  registerMediaScheme(SCHEME_PRIVILEGES);
}

// Enforces one process per profile to protect staged installs. Secondary instances open nothing and quit; the running instance raises its window.
if (!app.requestSingleInstanceLock()) app.quit();
else if (client) await import('./client/clientApp');
else {
  // After the lock: a second instance quits without asking the shell.
  applyShellPath();
  // Core inherits it (CoreClient), so both processes load the same plugins. A plugin or folder failure refuses or reports only itself.
  const installedRoot = profilePath(INSTALLED_PLUGINS_DIR);
  process.env[INSTALLED_ENV] = encodeInstalledStart(installedRoot, prepareInstalled(installedRoot, diag));
  await import('./app');
}
