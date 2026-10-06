import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { ARCHIVE_DB_FILE, ARCHIVE_MEDIA_DIR, type AppEvent, type StorageInfo } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { BYTES_PER_GB } from '@shared/units';
import type { CoreClient } from './coreClient';
import { diag } from './diagnostics';
import { pickFolder } from './dialogs';
import { PARTIAL_DOWNLOAD_PREFIX } from './media/attachmentDownloader';
import { saveStorageConfig, storageConfig } from './storageLocation';

/** The target drive must have the archive's size plus this share of it free, so it isn't left full. */
const FREE_SPACE_HEADROOM = 0.1;
/** Copy progress is reported at most this often. */
const PROGRESS_INTERVAL_MS = 250;
const DB_FILES = [ARCHIVE_DB_FILE, `${ARCHIVE_DB_FILE}-wal`, `${ARCHIVE_DB_FILE}-shm`];

interface ArchiveFile {
  /** Path relative to the archive folder. */
  rel: string;
  bytes: number;
}

export interface MoveHooks {
  /** Stops downloads and sync and closes the database. */
  stop(): Promise<void>;
  emit(e: AppEvent): void;
  /** Relaunches the app through its graceful close (the Discord login is kept). */
  restart(): void;
}

const gb = (bytes: number): string => `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
const sum = (files: ArchiveFile[]): number => files.reduce((n, f) => n + f.bytes, 0);

/** The archive's own files only: the folder may be the app profile, which holds much else. */
async function listArchive(dir: string): Promise<ArchiveFile[]> {
  const out: ArchiveFile[] = [];
  for (const f of DB_FILES) if (existsSync(join(dir, f))) out.push({ rel: f, bytes: (await stat(join(dir, f))).size });
  const media = join(dir, ARCHIVE_MEDIA_DIR);
  if (!existsSync(media)) return out;
  for (const e of await readdir(media, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith(PARTIAL_DOWNLOAD_PREFIX)) continue;
    const abs = join(e.parentPath, e.name);
    out.push({ rel: relative(dir, abs), bytes: (await stat(abs)).size });
  }
  return out;
}

const within = (parent: string, child: string): boolean => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

async function problemWith(from: string, to: string, bytes: number): Promise<string | null> {
  if (within(from, to)) return 'Choose a folder outside the current archive folder.';
  if (DB_FILES.some((f) => existsSync(join(to, f))) || existsSync(join(to, ARCHIVE_MEDIA_DIR))) return 'That folder already holds a ChattyPop archive.';
  const fs = await statfs(to);
  const need = bytes * (1 + FREE_SPACE_HEADROOM);
  if (fs.bavail * fs.bsize < need) return `That drive has ${gb(fs.bavail * fs.bsize)} free; the archive needs about ${gb(need)}.`;
  return null;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function storageInfo(): StorageInfo {
  const cfg = storageConfig();
  return { dir: cfg.archiveDir, previousDir: cfg.verifyOnOpen ? null : (cfg.previousDir ?? null) };
}

/** Copies archive to an owner-selected folder, verifies sizes/database bytes, updates location and restarts. Keeps original; failures remove partial copies and restart original. */
export async function moveArchive(win: BrowserWindow, hooks: MoveHooks): Promise<void> {
  const from = storageConfig().archiveDir;
  const to = await pickFolder(win, 'Move the archive to…');
  if (!to) return;
  const problem = await problemWith(from, to, sum(await listArchive(from)));
  if (problem) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'Can’t move the archive there', detail: problem });
    return;
  }

  hooks.emit({ type: 'storage-move', phase: 'stopping', doneBytes: 0, totalBytes: 0 });
  await hooks.stop();
  const files = await listArchive(from);
  const totalBytes = sum(files);
  try {
    let doneBytes = 0;
    let reportedAt = 0;
    for (const f of files) {
      const dest = join(to, f.rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(from, f.rel), dest);
      doneBytes += f.bytes;
      if (Date.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
        reportedAt = Date.now();
        hooks.emit({ type: 'storage-move', phase: 'copying', doneBytes, totalBytes });
      }
    }
    hooks.emit({ type: 'storage-move', phase: 'verifying', doneBytes, totalBytes });
    for (const f of files) {
      if ((await stat(join(to, f.rel))).size !== f.bytes) throw new Error(`${f.rel} was not copied completely.`);
    }
    if ((await sha256(join(from, ARCHIVE_DB_FILE))) !== (await sha256(join(to, ARCHIVE_DB_FILE)))) throw new Error('The database copy differs from the original.');
  } catch (err) {
    const message = errorMessage(err);
    diag('storage-move-failed', { message });
    hooks.emit({ type: 'storage-move', phase: 'error', doneBytes: 0, totalBytes, message });
    await removeArchive(to);
    await dialog.showMessageBox(win, { type: 'error', message: 'Moving the archive failed', detail: `${message}\nThe archive stays in ${from}. ChattyPop will restart.` });
    hooks.restart();
    return;
  }
  saveStorageConfig({ archiveDir: to, previousDir: from, verifyOnOpen: true });
  diag('storage-moved', { bytes: totalBytes, files: files.length });
  hooks.emit({ type: 'storage-move', phase: 'restarting', doneBytes: totalBytes, totalBytes });
  hooks.restart();
}

/** First start after a move: the copied database must pass SQLite's quick_check, else the app returns to the original. */
export async function verifyMovedArchive(win: BrowserWindow, core: CoreClient, restart: () => void): Promise<void> {
  const cfg = storageConfig();
  if (!cfg.verifyOnOpen) return;
  const result = await core.call('integrityCheck').catch(errorMessage);
  if (result === 'ok') {
    saveStorageConfig({ archiveDir: cfg.archiveDir, ...(cfg.previousDir ? { previousDir: cfg.previousDir } : {}) });
    return;
  }
  diag('storage-verify-failed', { result });
  if (!cfg.previousDir) return;
  saveStorageConfig({ archiveDir: cfg.previousDir });
  await dialog.showMessageBox(win, {
    type: 'error',
    message: 'The moved archive failed its integrity check',
    detail: `${result}\nChattyPop will restart on the original in ${cfg.previousDir}. The copy in ${cfg.archiveDir} is left for inspection.`,
  });
  restart();
}

/** Deletes the pre-move copy after the user confirms in a system dialog. */
export async function deletePreviousArchive(win: BrowserWindow): Promise<void> {
  const { previousDir } = storageInfo();
  const cfg = storageConfig();
  if (!previousDir) return;
  const bytes = sum(await listArchive(previousDir));
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Delete the old copy of the archive?',
    detail: `${gb(bytes)} in ${previousDir} (the database and media folder only). The archive in ${cfg.archiveDir} is not affected. This can’t be undone.`,
  });
  if (response !== 0) return;
  await removeArchive(previousDir);
  saveStorageConfig({ archiveDir: cfg.archiveDir });
}

/** Removes only the archive's own files from a folder. */
async function removeArchive(dir: string): Promise<void> {
  for (const f of DB_FILES) await rm(join(dir, f), { force: true });
  await rm(join(dir, ARCHIVE_MEDIA_DIR), { recursive: true, force: true });
}
