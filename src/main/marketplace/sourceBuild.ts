// Source installs' build (docs/plugin-architecture.md §16): the plugin's own packages installed with npm, then the same
// build that makes release assets, loaded only when a source install runs, since it brings in Vite. Vite and the Solid
// plugin are development packages: they exist when ChattyPop runs from its source checkout, which is how it runs today.
import { app } from 'electron';
import type { BuildPlugin } from './marketplaces';
import { installPluginPackages } from './npm';

/** Node's code for a package it can't find. */
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';
/** Runtime packages only; no install scripts (a package's code runs only as part of the plugin, never at install). */
const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];

export const buildFromSource: BuildPlugin = async (pluginDir, outDir) => {
  let pluginBuild: typeof import('../pluginBuild');
  try {
    pluginBuild = await import('../pluginBuild');
  } catch (err) {
    if ((err as { code?: unknown }).code === MODULE_NOT_FOUND) {
      throw new Error('Building a plugin from source needs ChattyPop run from its source checkout (Vite is missing). Install a release instead.');
    }
    throw err;
  }
  await installPluginPackages(pluginDir, NPM_INSTALL_ARGS);
  return pluginBuild.buildInstalledPlugin({ pluginDir, outDir, appVersion: app.getVersion() });
};
