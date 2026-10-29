// Applies staged installs/updates/removals before loading plugins. Idempotent rename/delete steps recover crashes; failed steps defer that plugin’s remaining work.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HELD_DIR, REMOVED_DIR, STAGED_DIR, TRASH_DIR } from '@shared/installedPlugins';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';

/** Plugin ids named by `root`'s installer folder `name`; other names (another tool's files) are left alone. null: unlistable, reported. */
function idsIn(root: string, name: string, onError: (id: string, err: unknown) => void): string[] | null {
  const dir = join(root, name);
  try {
    return existsSync(dir) ? readdirSync(dir).filter((entry) => PLUGIN_ID_PATTERN.test(entry)).sort() : [];
  } catch (err) {
    onError(name, err);
    return null;
  }
}

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

/** Settles held staged copies: discard when replacement exists, otherwise restore to staged. Returns ids still held after failures; null when unlistable. */
function settleHeld(root: string, onError: (id: string, err: unknown) => void): Set<string> | null {
  const blocked = new Set<string>();
  const held = idsIn(root, HELD_DIR, onError);
  if (!held) return null;
  for (const id of held) {
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
 * Settles held copies, applies removal markers then staged installs, and empties trash. Reports failures and defers that
 * plugin’s later steps until next startup. An unlistable held or removal folder defers every staged install, since any may be blocked.
 */
export function applyStaged(root: string, onError: (id: string, err: unknown) => void): void {
  const blocked = settleHeld(root, onError);
  const removed = blocked && idsIn(root, REMOVED_DIR, onError);
  if (blocked && removed) {
    for (const id of removed) {
      if (blocked.has(id)) continue;
      try {
        discard(root, id);
        rmSync(join(root, REMOVED_DIR, id), { force: true });
      } catch (err) {
        onError(id, err);
        blocked.add(id);
      }
    }
    for (const id of idsIn(root, STAGED_DIR, onError) ?? []) {
      if (blocked.has(id)) continue;
      try {
        discard(root, id);
        renameSync(join(root, STAGED_DIR, id), join(root, id));
      } catch (err) {
        onError(id, err);
      }
    }
  }
  try {
    rmSync(join(root, TRASH_DIR), { recursive: true, force: true });
  } catch (err) {
    onError(TRASH_DIR, err);
  }
}
