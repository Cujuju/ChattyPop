import { constants } from 'node:fs';
import { copyFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, win32 } from 'node:path';
import { SHA256_HEX, SAFE_EXT, attachmentFileName, attachmentShard, savedFileName, type StoredFile } from '@shared/media';
import type { FolderSaveResult, FolderSaveProgress } from '@shared/types/attachmentStore';

export function storedExportFile(value: unknown): StoredFile {
  const f = value as Partial<StoredFile> | null;
  if (!f || typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256) || typeof f.filename !== 'string' || !f.filename
    || f.filename.includes('\0') || !(f.storedExt === null || (typeof f.storedExt === 'string' && SAFE_EXT.test(f.storedExt))))
    throw new Error('Not an archived attachment.');
  return { sha256: f.sha256, filename: f.filename, storedExt: f.storedExt };
}

/** Resolving both paths also rejects a shard or file symlink that escapes the attachment store. */
export async function storedExportPath(dir: string, file: StoredFile): Promise<string> {
  const root = await realpath(dir);
  const source = await realpath(join(root, attachmentShard(file.sha256), attachmentFileName(file)));
  const part = relative(root, source);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Not a stored attachment path.');
  return source;
}

/** A portable leaf name; Discord names can contain path separators or Windows device names. */
export function exportLeafName(file: StoredFile): string {
  let name = basename(win32.basename(savedFileName(file))).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

const FIRST_COLLISION = 2;
/** Windows' and most file systems' longest path component, in UTF-16 units. */
export const MAX_LEAF_CHARS = 255;

/** `stem` shortened so `stem + tail` fits one path component; a cut never splits a surrogate pair. */
function fitLeaf(stem: string, tail: string): string {
  const room = MAX_LEAF_CHARS - tail.length;
  if (stem.length <= room) return stem + tail;
  const cut = /[\uD800-\uDBFF]/.test(stem[room - 1] ?? '') ? room - 1 : room;
  // Windows drops a name's trailing dots and spaces, so a cut never ends on one.
  return stem.slice(0, cut).replace(/[. ]+$/, '') + tail;
}

/** `name`, or its numbered collision form, within MAX_LEAF_CHARS; a file-type extension (SAFE_EXT) is never cut. */
export function exportCandidate(name: string, suffix: number | null): string {
  const ext = extname(name);
  const keepExt = SAFE_EXT.test(ext.slice(1).toLowerCase());
  const stem = keepExt ? name.slice(0, -ext.length) : name;
  return fitLeaf(stem, `${suffix === null ? '' : ` (${suffix})`}${keepExt ? ext : ''}`);
}

/** Exclusive copies preserve existing files, including collisions created by another concurrent export. */
async function copyUnique(source: string, folder: string, name: string): Promise<void> {
  for (let suffix: number | null = null; ; suffix = suffix === null ? FIRST_COLLISION : suffix + 1) {
    try { await copyFile(source, join(folder, exportCandidate(name, suffix)), constants.COPYFILE_EXCL); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export async function copyAttachmentsToFolder(dir: string, files: StoredFile[], folder: string,
  progress: (p: FolderSaveProgress) => void): Promise<FolderSaveResult> {
  const result = { saved: 0, failed: 0, folder };
  for (const [index, file] of files.entries()) {
    try { await copyUnique(await storedExportPath(dir, file), folder, exportLeafName(file)); result.saved++; }
    catch { result.failed++; }
    if (files.length > 1) progress({ done: index + 1, total: files.length });
  }
  return result;
}
