// Staged installs, updates and removals of installed plugins (docs/plugin-architecture.md §16), applied at start before
// any plugin loads. Every step is a rename or a delete, so a crash at any point leaves a state the next start completes,
// and applying twice changes nothing. A step that fails holds back that plugin's later steps until the next start.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HELD_DIR, REMOVED_DIR, STAGED_DIR, TRASH_DIR } from '@shared/installedPlugins';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';

/** Plugin ids named by `dir`'s entries; other names (another tool's files) are left alone. */
const idsIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => PLUGIN_ID_PATTERN.test(name)).sort() : []);

/** A free path in `trash` for plugin `id`'s folder: a crash, or a file held open, may have left an earlier one. */
function trashPath(trash: string, id: string): string {
  for (let n = 0; ; n++) {
    const path = join(trash, n === 0 ? id : `${id}.${n}`);
    if (!existsSync(path)) return path;
  }
}

/** Moves plugin `id`'s folder into the trash, when it is installed. */
function discard(root: string, id: string): void {
  const dir = join(root, id);
  if (!existsSync(dir)) return;
  const trash = join(root, TRASH_DIR);
  mkdirSync(trash, { recursive: true });
  renameSync(dir, trashPath(trash, id));
}

/**
 * Finishes replacements of staged copies (InstalledFolder.stage): a held copy whose replacement is staged is deleted;
 * one without goes back to `.staged`, since the swap never finished. Returns the ids whose held copy is still there.
 */
function settleHeld(root: string, onError: (id: string, err: unknown) => void): Set<string> {
  const blocked = new Set<string>();
  for (const id of idsIn(join(root, HELD_DIR))) {
    const held = join(root, HELD_DIR, id);
    try {
      if (existsSync(join(root, STAGED_DIR, id))) rmSync(held, { recursive: true, force: true });
      else {
        mkdirSync(join(root, STAGED_DIR), { recursive: true });
        renameSync(held, join(root, STAGED_DIR, id));
      }
    } catch (err) {
      onError(id, err);
      blocked.add(id);
    }
  }
  return blocked;
}

/**
 * Applies the changes staged under `root` (the installed-plugins folder): held copies settle first; each
 * `.removed/<id>` discards `<id>`, then drops its marker; then each `.staged/<id>` discards `<id>` and takes its place.
 * The trash is emptied last. A step that fails is reported to `onError` and tried again at the next start; that plugin's
 * later steps wait for it, so a marker left behind can't remove the copy installed after it.
 */
export function applyStaged(root: string, onError: (id: string, err: unknown) => void): void {
  const blocked = settleHeld(root, onError);
  for (const id of idsIn(join(root, REMOVED_DIR))) {
    if (blocked.has(id)) continue;
    try {
      discard(root, id);
      rmSync(join(root, REMOVED_DIR, id), { force: true });
    } catch (err) {
      onError(id, err);
      blocked.add(id);
    }
  }
  for (const id of idsIn(join(root, STAGED_DIR))) {
    if (blocked.has(id)) continue;
    try {
      discard(root, id);
      renameSync(join(root, STAGED_DIR, id), join(root, id));
    } catch (err) {
      onError(id, err);
    }
  }
  try {
    rmSync(join(root, TRASH_DIR), { recursive: true, force: true });
  } catch (err) {
    onError(TRASH_DIR, err);
  }
}
