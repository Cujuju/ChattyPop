// Bundled plugins' data folders (their storage.dataDir): downloads that belong to this computer, not the (movable) archive.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { errorMessage } from '@shared/errors';
import type { PluginDataDirs } from '@shared/contract';
import { diag } from '../diagnostics';
import { profilePath } from '../storageLocation';

/** Under the app profile; one folder per plugin id. */
const PLUGIN_DATA_DIR = 'plugin-data';

/**
 * The plugin data root, created, with adopted profile folders (PluginDescriptor.adopts.dataDir) moved in: a rename on
 * the same volume. A folder that can't be moved (a file held open) stays in use where it is this run, and the move is
 * tried again next start.
 */
export function pluginDataDirs(): PluginDataDirs {
  const root = profilePath(PLUGIN_DATA_DIR);
  mkdirSync(root, { recursive: true });
  const unmoved: Record<string, string> = {};
  for (const { manifest, adopts } of BUNDLED_PLUGINS) {
    const { id } = manifest;
    const legacy = adopts?.dataDir;
    if (legacy === undefined) continue;
    const from = profilePath(legacy);
    const to = join(root, id);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      diag('plugin-data-legacy-left', { pluginId: id, legacy: from }); // both exist: the old one is no longer used
      continue;
    }
    try {
      renameSync(from, to);
    } catch (err) {
      diag('plugin-data-move-failed', { pluginId: id, message: errorMessage(err) });
      unmoved[id] = from;
    }
  }
  return { root, unmoved };
}
