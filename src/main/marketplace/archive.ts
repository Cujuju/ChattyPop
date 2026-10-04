// Unpacks a .tar.gz into a folder, refusing any entry that isn't a plain file or folder inside it.
import { mkdirSync } from 'node:fs';
import { extract } from 'tar';

/** Entry types that are plain files or folders; links, devices and FIFOs are refused. */
const PLAIN_TYPES = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

/** Why an entry path is refused: absolute (either slash style, or a drive), or with a `..` part; null when fine. */
export function unsafeEntryPath(path: string): string | null {
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return 'an absolute path';
  if (path.split(/[\\/]/).includes('..')) return 'a path outside the folder';
  return null;
}

/** Unpacks `file` (.tar.gz) into `dir` (created); throws naming the first refused entry. */
export async function extractTarGz(file: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  let refused: string | null = null;
  await extract({
    file,
    cwd: dir,
    strict: true,
    preservePaths: false,
    filter: (path, entry) => {
      const type = 'type' in entry ? entry.type : null;
      const reason = type !== null && !PLAIN_TYPES.has(type) ? `a ${type}` : unsafeEntryPath(path);
      if (reason && !refused) refused = `The archive holds ${reason} (${path}), which is refused.`;
      return !reason && !refused;
    },
  });
  if (refused) throw new Error(refused);
}
