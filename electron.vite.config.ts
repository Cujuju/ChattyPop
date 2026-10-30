import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import solid from 'vite-plugin-solid';
import type { Plugin } from 'vite';
import { appVersion } from './appVersion';
import { NO_PLUGIN_SOURCE, bundledPlugins, devPluginSource, pageInputs, pagesPlugin, pluginDirs } from './bundledPlugins';

const shared = resolve(import.meta.dirname, 'src/shared');
/** Plugins import only the Plugin SDK (docs/plugin-architecture.md). */
const pluginSdk = resolve(import.meta.dirname, 'src/plugin-sdk');
const hostAliases = { '@shared': shared, '@core': resolve(import.meta.dirname, 'src/core'), '@main': resolve(import.meta.dirname, 'src/main'), '@plugin-sdk': pluginSdk };
/** Created by `pnpm release keygen`; without it the build cannot verify updates, so it never updates. */
const UPDATE_PUBLIC_KEY_FILE = resolve(import.meta.dirname, 'build/update-public-key.pem');
/** Reads once at startup; main, core, and renderer share the value. */
const versionDefine = {
  __APP_VERSION__: JSON.stringify(appVersion(import.meta.dirname)),
  __UPDATE_PUBLIC_KEY__: JSON.stringify(existsSync(UPDATE_PUBLIC_KEY_FILE) ? readFileSync(UPDATE_PUBLIC_KEY_FILE, 'utf8').trim() : ''),
};
/** A module's own folder is out/main only in an entry chunk; shared chunks land in out/main/chunks. */
const ENTRY_RELATIVE_PATH = /import\.meta\.(?:dirname|filename)/;
const entryPathsInEntries: Plugin = {
  name: 'entry-paths-in-entries',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk' && !chunk.isEntry && ENTRY_RELATIVE_PATH.test(chunk.code)) {
        this.error(`${chunk.fileName} uses import.meta.dirname: pass the path from a build entry (src/core/index.ts) instead`);
      }
    }
  },
};
/** electron-vite's renderer root: pages are named relative to it. */
const rendererRoot = resolve(import.meta.dirname, 'src/renderer');
export default defineConfig(({ command }) => {
  // Development builds include local plugin clones; production builds exclude them.
  const plugins = command === 'serve' ? devPluginSource() : NO_PLUGIN_SOURCE;
  return {
    main: {
      resolve: { alias: hostAliases },
      plugins: [bundledPlugins(import.meta.dirname, 'node', plugins), entryPathsInEntries],
      define: versionDefine,
      build: {
        // Source installs load plugin-build tools on demand as external packages.
        // The updater is bundled: a linked package isn't in the packaged app's node_modules.
        externalizeDeps: { include: ['vite', 'vite-plugin-solid'], exclude: ['@cujuju/electron-updates'] },
        rollupOptions: {
          // core runs in utilityProcess. index selects installed plugins before loading app; adjacent app and core entries preserve relative paths.
          input: {
            index: resolve(import.meta.dirname, 'src/main/index.ts'),
            app: resolve(import.meta.dirname, 'src/main/app.ts'),
            // Client mode (--connect): a server's desktop UI in this app's windows; no core, no Discord.
            client: resolve(import.meta.dirname, 'src/main/client/clientApp.ts'),
            core: resolve(import.meta.dirname, 'src/core/index.ts'),
            archiveReadProcess: resolve(import.meta.dirname, 'src/core/reads/archiveReadProcess.ts'),
            archiveReadWorker: resolve(import.meta.dirname, 'src/core/reads/archiveReadWorker.ts'),
          },
        },
      },
    },
    preload: {
      resolve: { alias: { '@shared': shared } },
      build: {
        rollupOptions: {
          // One entry for every window (the app's, a client's server windows and its connect page): a sandboxed
          // preload can't load a second file, so it must not split into chunks. It picks its role from its arguments.
          // Sandboxed preloads must be CommonJS.
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      server: {
        // The dev server serves the plugin folders outside the repo (local plugin-repo clones).
        fs: { allow: [import.meta.dirname, ...pluginDirs(plugins.dirs)] },
        // Transforms the app page's import graph as the server starts, while main builds (scripts/dev.mjs), not on request.
        warmup: { clientFiles: ['./src/main.tsx'] },
      },
      resolve: {
        alias: { '@shared': shared, '@': resolve(import.meta.dirname, 'src/renderer/src'), '@plugin-sdk': pluginSdk },
        // Linked @cujuju packages carry their own solid-js; a second runtime can't track this app's signals.
        dedupe: ['solid-js'],
      },
      // The host and plugins share this toolkit; its Solid JSX needs the Solid transform rather than dependency prebundling.
      optimizeDeps: { exclude: ['@cujuju/solidjs-hold-action'] },
      plugins: [solid(), bundledPlugins(import.meta.dirname, 'browser', plugins), pagesPlugin(rendererRoot, plugins)],
      define: versionDefine,
      build: {
        rollupOptions: {
          // The app's page, and each included plugin's own page (<id>.html, e.g. the phone companion's).
          input: {
            index: resolve(rendererRoot, 'index.html'),
            splash: resolve(rendererRoot, 'splash.html'),
            connect: resolve(rendererRoot, 'connect.html'),
            ...pageInputs(rendererRoot, plugins),
          },
        },
      },
    },
  };
});
