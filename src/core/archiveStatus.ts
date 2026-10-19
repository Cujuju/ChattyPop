import { stat } from 'node:fs/promises';
import type { CoreStatus } from '@shared/contract';
import type { Db } from './db';
import { readHost } from './reads/archiveReads';

type Metadata = Pick<CoreStatus, 'sqliteVersion' | 'cipher' | 'fts5' | 'schemaVersion'>;
/** SQLite side files in WAL mode; recent writes live in -wal until checkpointed. */
const DB_SIDE_FILES = ['', '-wal', '-shm'];

/** SQLite metadata can fault cold archive pages in; it belongs to the read helper too. */
export function statusMetadata(db: Db): Metadata {
  return {
    sqliteVersion: db.prepare('SELECT sqlite_version() AS v').pluck().get() as string,
    cipher: String(db.pragma('cipher', { simple: true })),
    fts5: db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fts_messages'").get() !== undefined,
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
  };
}

export async function readStatus(db: Db, path: string, mediaBytes: number, encrypted: boolean): Promise<Omit<CoreStatus, 'textOverCapBytes'>> {
  const [[metadata], sizes] = await Promise.all([
    readHost<Metadata>(db, { kind: 'status' }),
    Promise.all(DB_SIDE_FILES.map(async (suffix) => {
      try { return (await stat(path + suffix)).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    })),
  ]);
  const dbBytes = sizes.reduce((sum, size) => sum + size, 0);
  return { ...metadata!, encrypted, dbPath: path, dbBytes, mediaBytes, totalBytes: dbBytes + mediaBytes };
}
