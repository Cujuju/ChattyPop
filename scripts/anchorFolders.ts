// Checks external plugins beside their repository siblings. Stamped anchors on absent siblings remain valid.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SHARED_ENTRY } from '../src/main/pluginBuild/descriptor';

/** The plugin folders beside `pluginDir`, `pluginDir` included (the build leaves its id out). */
export function anchorFolders(pluginDir: string): string[] {
  const dir = dirname(resolve(pluginDir));
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, SHARED_ENTRY)))
    .map((e) => join(dir, e.name));
}
