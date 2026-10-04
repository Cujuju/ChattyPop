import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { appVersion } from './appVersion';
import { NO_PLUGIN_SOURCE, bundledPlugins, type PluginSource } from './bundledPlugins';
import { HOST_TESTING_FILES } from './tests/hostTesting/files';

/** The test config, its plugin registry built from `plugins`: none for the host's tests, one plugin for plugin:check. */
export const testConfig = (plugins: PluginSource = NO_PLUGIN_SOURCE) => defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(import.meta.dirname, 'src/shared') },
      { find: '@core', replacement: resolve(import.meta.dirname, 'src/core') },
      { find: '@main', replacement: resolve(import.meta.dirname, 'src/main') },
      { find: '@plugin-sdk', replacement: resolve(import.meta.dirname, 'src/plugin-sdk') },
      // The host test kit plugin tests outside this checkout import (docs/plugin-architecture.md §16): its index, or
      // a listed helper in tests/ by name.
      { find: /^@chattypop\/host-testing$/, replacement: resolve(import.meta.dirname, 'tests/hostTesting/index.ts') },
      { find: new RegExp(`^@chattypop/host-testing/(${HOST_TESTING_FILES.join('|')})$`), replacement: `${resolve(import.meta.dirname, 'tests').replaceAll('\\', '/')}/$1` },
      { find: '@', replacement: resolve(import.meta.dirname, 'src/renderer/src') },
    ],
  },
  plugins: [bundledPlugins(import.meta.dirname, 'node', plugins)],
  define: { __APP_VERSION__: JSON.stringify(appVersion(import.meta.dirname)) },
  // tests/fixtures: plugin folders pnpm plugin:check runs (tests/pluginCheck.test.ts).
  test: { include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/fixtures/**'], environment: 'node', globalSetup: ['tests/globalSetup.ts'] },
});

export default testConfig();
