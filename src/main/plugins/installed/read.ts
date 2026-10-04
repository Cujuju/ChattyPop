// An installed plugin's folder as main and core read it: plugin.json and source.json (docs/plugin-architecture.md §16).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALLED_MANIFEST_FILE, INSTALLED_SOURCE_FILE, parseInstalledManifest, parseInstalledSource, type InstalledPlugin, type InstalledSource } from '@shared/installedPlugins';

/** source.json, or null when absent or unreadable: it only says where updates come from, so it never refuses a plugin. */
function readInstalledSource(dir: string): InstalledSource | null {
  try {
    return parseInstalledSource(JSON.parse(readFileSync(join(dir, INSTALLED_SOURCE_FILE), 'utf8')));
  } catch {
    return null;
  }
}

/** The plugin in folder `dir`; throws when its plugin.json is missing or refused. */
export function readInstalledPlugin(dir: string): InstalledPlugin {
  const manifest = parseInstalledManifest(JSON.parse(readFileSync(join(dir, INSTALLED_MANIFEST_FILE), 'utf8')));
  return { dir, manifest, source: readInstalledSource(dir) };
}
