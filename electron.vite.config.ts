import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import solid from 'vite-plugin-solid';
import { appVersion } from './appVersion';
import { NO_PLUGIN_SOURCE, bundledPlugins, devPluginSource, pageInputs, pagesPlugin, pluginDirs } from './bundledPlugins';

const shared = resolve(import.meta.dirname, 'src/shared');
/** Plugins import only the Plugin SDK (docs/plugin-architecture.md). */
const pluginSdk = resolve(import.meta.dirname, 'src/plugin-sdk');
const hostAliases = { '@shared': shared, '@core': resolve(import.meta.dirname, 'src/core'), '@main': resolve(import.meta.dirname, 'src/main'), '@plugin-sdk': pluginSdk };
/** Reads once at startup; main, core, and renderer share the value. */
const versionDefine = { __APP_VERSION__: JSON.stringify(appVersion(import.meta.dirname)) };
/** electron-vite's renderer root: pages are named relative to it. */
const rendererRoot = resolve(import.meta.dirname, 'src/renderer');
export default defineConfig(({ command }) => {
  // Development builds include local plugin clones; production builds exclude them.
  const plugins = command === 'serve' ? devPluginSource() : NO_PLUGIN_SOURCE;
  return {
    main: {
      resolve: { alias: hostAliases },
      plugins: [bundledPlugins(import.meta.dirname, 'node', plugins)],
      define: versionDefine,
      build: {
        // Source installs load plugin-build tools on demand as external packages.
        externalizeDeps: { include: ['vite', 'vite-plugin-solid'] },
        rollupOptions: {
          // core runs in utilityProcess. index selects installed plugins before loading app; adjacent app and core entries preserve relative paths.
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
