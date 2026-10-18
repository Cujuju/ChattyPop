import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Db } from '../db';
import { ArchiveReadPool } from './pool';
import type { ReadQuery } from './protocol';

interface Readers { key: string | null; pool?: ArchiveReadPool; closed: boolean }
const readers = new WeakMap<Db, Readers>();

/** An async snapshot must not outlive the privacy state that permitted its rows. */
export function archiveReadPrivacyChanged(db: Db): void {
  readers.get(db)?.pool?.cancel(new Error('Archive visibility changed; repeat the lookup'));
}

/** Called only after opening or rekeying; keys stay in core/helper memory. */
export function configureArchiveReads(db: Db, key: string | null): void {
  const state = readers.get(db);
  if (state) { state.key = key; state.closed = false; return; }
  readers.set(db, { key, closed: false });
  const close = db.close.bind(db);
  db.close = () => { void closeArchiveReads(db); return close(); };
}

/** Drain owned processes before a file move, rekey or test-folder removal. New reads reject until configured again. */
export async function closeArchiveReads(db: Db): Promise<void> {
  const state = readers.get(db);
  if (!state) return;
  state.closed = true;
  await state.pool?.close();
  state.pool = undefined;
}

/** A failed rekey retains the last key whose PRAGMA completed. */
export function resumeArchiveReads(db: Db): void {
  const state = readers.get(db);
  if (state) state.closed = false;
}

export function readArchive<R>(db: Db, sql: string, params: ReadQuery['params'], signal?: AbortSignal): Promise<R[]> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const state = readers.get(db);
  if (!db.open || !state || state.closed) return Promise.reject(new Error('Archive reader is closed'));
  if (db.inTransaction) return Promise.reject(new Error('Async archive reads cannot observe an uncommitted transaction'));
  // Vitest builds the same reader entries separately; production and development use entries adjacent to core.
  const adjacent = join(import.meta.dirname, 'archiveReadProcess.js');
  const entry = existsSync(adjacent) ? adjacent : process.env.VITEST ? join(import.meta.dirname, '../../../out/read-tests/archiveReadProcess.js') : adjacent;
  state.pool ??= new ArchiveReadPool({ path: db.name, key: state.key }, entry);
  return state.pool.read<R>(sql, params, signal);
}
