import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = path.join(repoRoot, 'native', 'window-border');
const required = process.argv.includes('--require');
const binary = path.join(addonDir, 'build', 'Release', 'window_border.node');
const sources = [
  path.join(addonDir, 'window_border.c'),
  path.join(addonDir, 'window_rect.c'),
  path.join(addonDir, 'window_rect.h'),
  path.join(addonDir, 'binding.gyp'),
];

/** Windows-only: the border it removes is a Win32/DWM artifact. */
if (process.platform !== 'win32') {
  process.exit(0);
}

/** Up to date when the binary exists and post-dates every source file. */
function isFresh() {
  if (!existsSync(binary)) return false;
  const builtAt = statSync(binary).mtimeMs;
  return sources.every((src) => !existsSync(src) || statSync(src).mtimeMs <= builtAt);
}

if (isFresh()) {
  console.log('[window-border] native addon is up to date:', binary);
  process.exit(0);
}

console.log('[window-border] building native addon…');

// node-gyp ships INSIDE npm; resolving it from npm's own install avoids adding a
// node-gyp dependency to this repo just for one prestep.
const npmDir = path.dirname(process.execPath);
const nodeGyp = path.join(npmDir, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');

/** Failed rebuilds quarantine any surviving binary; --require makes failure fatal. */
function abandonBuild(reason) {
  if (!existsSync(binary)) {
    console.warn(`[window-border] ${reason}; no binary present, so windows keep their 1px border.`);
    process.exit(required ? 1 : 0);
  }
  const quarantined = `${binary}.stale`;
  try {
    rmSync(quarantined, { force: true });
    renameSync(binary, quarantined);
    console.warn(
      `[window-border] ${reason}. The PREVIOUS binary was still on disk and would have\n` +
      `                loaded silently, running the old addon behaviour as if the sources\n` +
      `                had built. Quarantined it to ${quarantined};\n` +
      `                windows keep their 1px border until a build succeeds.`,
    );
  } catch (err) {
    // Cannot move it (locked by a running Electron?). Say so LOUDLY: this is the
    // one path where the app may still come up on the old addon.
    console.warn(
      `[window-border] ${reason}, AND the stale binary could not be quarantined ` +
      `(${err.message}). ${binary} WILL LOAD and the app will run the PREVIOUS addon ` +
      `behaviour — do not trust a native-side change until this builds. ` +
      `Close any running instance and retry.`,
    );
  }
  process.exit(required ? 1 : 0);
}

if (!existsSync(nodeGyp)) {
  abandonBuild(`node-gyp not found at ${nodeGyp}`);
}

const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: addonDir,
  stdio: 'inherit',
});

if (result.status !== 0 || !existsSync(binary)) {
  abandonBuild(result.status !== 0 ? `build failed (node-gyp exit ${result.status})` : 'build produced no binary');
}

// A good build supersedes any quarantined predecessor — leaving it around only
// invites someone to "restore" it later.
rmSync(`${binary}.stale`, { force: true });

console.log('[window-border] built', binary);
