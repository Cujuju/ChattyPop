import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import solid from 'vite-plugin-solid';
import { appVersion } from './appVersion';
import { NO_PLUGIN_SOURCE, bundledPlugins, devPluginSource, pageInputs, pagesPlugin, pluginDirs } from './bundledPlugins';

const shared = resolve(import.meta.dirname, 'src/shared');
/** Plugins import only the Plugin SDK (docs/plugin-architecture.md). */
const pluginSdk = resolve(import.meta.dirname, 'src/plugin-sdk');
const hostAliases = { '@shared': shared, '@core': resolve(import.meta.dirname, 'src/core'), '@main': resolve(import.meta.dirname, 'src/main'), '@plugin-sdk': pluginSdk };
/** Read once when the build or dev server starts; main, core and renderer all see this value. */
const versionDefine = { __APP_VERSION__: JSON.stringify(appVersion(import.meta.dirname)) };
/** electron-vite's renderer root: pages are named relative to it. */
const rendererRoot = resolve(import.meta.dirname, 'src/renderer');
export default defineConfig(({ command }) => {
  // Only the dev server compiles in the plugin repos' clones; a build (dist, package, preview) ships none.
  const plugins = command === 'serve' ? devPluginSource() : NO_PLUGIN_SOURCE;
  return {
    main: {
      resolve: { alias: hostAliases },
      plugins: [bundledPlugins(import.meta.dirname, 'node', plugins)],
      define: versionDefine,
      build: {
        // Source installs load the plugin build (src/main/pluginBuild) on demand; its build tools stay packages, not bundled.
        externalizeDeps: { include: ['vite', 'vite-plugin-solid'] },
        rollupOptions: {
          // `core` runs in Electron utilityProcess (SQLite, ingest, AI, plugins). `index` boots main, importing `app`
          // once installed plugins are decided; `app` is an entry beside core.js so its paths resolve.
          input: {
            index: resolve(import.meta.dirname, 'src/main/index.ts'),
            app: resolve(import.meta.dirname, 'src/main/app.ts'),
            core: resolve(import.meta.dirname, 'src/core/index.ts'),
          },
        },
      },
    },
    preload: {
      resolve: { alias: { '@shared': shared } },
      build: {
        rollupOptions: {
          // Sandboxed preloads must be CommonJS.
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      // The dev server serves the plugin folders outside the repo (local plugin-repo clones).
      server: { fs: { allow: [import.meta.dirname, ...pluginDirs(plugins.dirs)] } },
      resolve: {
        alias: { '@shared': shared, '@': resolve(import.meta.dirname, 'src/renderer/src'), '@plugin-sdk': pluginSdk },
        // Linked @cujuju packages carry their own solid-js; a second runtime can't track this app's signals.
        dedupe: ['solid-js'],
      },
      plugins: [solid(), bundledPlugins(import.meta.dirname, 'browser', plugins), pagesPlugin(rendererRoot, plugins)],
      define: versionDefine,
      build: {
        rollupOptions: {
          // The app's page, and each included plugin's own page (<id>.html, e.g. the phone companion's).
          input: {
            index: resolve(rendererRoot, 'index.html'),
            ...pageInputs(rendererRoot, plugins),
          },
        },
      },
    },
  };
});
