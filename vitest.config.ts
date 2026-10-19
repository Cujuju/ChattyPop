import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { appVersion } from './appVersion';
import { NO_PLUGIN_SOURCE, bundledPlugins, type PluginSource } from './bundledPlugins';
import { HOST_TESTING_FILES } from './tests/hostTesting/files';

/**
 * A test's (and its hooks') own time before it fails as stuck. Tests open real SQLite files through every migration; on a busy hosted
 * runner that runs up to 7× its usual time (a 0.75 s test past 5 s), so vitest's 5 s default fails sound tests.
 */
const TEST_TIMEOUT_MS = 30_000;
/** Native read helpers multiply processes per test worker; shared machines can bound test concurrency explicitly. */
const TEST_WORKERS = process.env.CHATTYPOP_TEST_WORKERS ? Number(process.env.CHATTYPOP_TEST_WORKERS) : undefined;

/** The test config, its plugin registry built from `plugins`: none for the host's tests, one plugin for plugin:check. */
export const testConfig = (plugins: PluginSource = NO_PLUGIN_SOURCE) => defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(import.meta.dirname, 'src/shared') },
      { find: '@core', replacement: resolve(import.meta.dirname, 'src/core') },
      { find: '@main', replacement: resolve(import.meta.dirname, 'src/main') },
      { find: '@plugin-sdk', replacement: resolve(import.meta.dirname, 'src/plugin-sdk') },
      // Host-testing aliases expose the entry module and allowlisted helpers to external plugin tests.
      { find: /^@chattypop\/host-testing$/, replacement: resolve(import.meta.dirname, 'tests/hostTesting/index.ts') },
      { find: new RegExp(`^@chattypop/host-testing/(${HOST_TESTING_FILES.join('|')})$`), replacement: `${resolve(import.meta.dirname, 'tests').replaceAll('\\', '/')}/$1` },
      { find: '@', replacement: resolve(import.meta.dirname, 'src/renderer/src') },
    ],
  },
  plugins: [bundledPlugins(import.meta.dirname, 'node', plugins)],
  define: { __APP_VERSION__: JSON.stringify(appVersion(import.meta.dirname)) },
  // tests/fixtures: plugin folders pnpm plugin:check runs (tests/pluginCheck.test.ts).
  test: {
    maxWorkers: TEST_WORKERS,
    include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/fixtures/**'], environment: 'node', globalSetup: ['tests/globalSetup.ts'], setupFiles: ['tests/setupReads.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // The git tests run in throwaway repos: the owner's own git config (hooks, signing) mustn't reach them.
    // '/dev/null' is what git reads as no file on every platform; Node's devNull is not.
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  },
});

export default testConfig();
