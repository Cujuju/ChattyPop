import type { Db } from '../db';
import { ArchiveReadPool } from './pool';
import { archiveReadEntry } from './helperEntry';
import type { ReadPriority } from '@shared/readPriority';
import type { HostRead, ReadCompute, ReadQuery } from './protocol';

interface Readers { key: string | null; pool?: ArchiveReadPool; closed: boolean; zone: string }
const readers = new WeakMap<Db, Readers>();

/** An async snapshot must not outlive the privacy state that permitted its rows. */
export function archiveReadPrivacyChanged(db: Db): void {
  readers.get(db)?.pool?.cancel(new Error('Archive visibility changed; repeat the lookup'));
}

/** Called only after opening or rekeying; keys stay in core/helper memory. */
export function configureArchiveReads(db: Db, key: string | null): void {
  const state = readers.get(db);
  if (state) { state.key = key; state.closed = false; return; }
  readers.set(db, { key, closed: false, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
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

export function readArchive<R>(db: Db, sql: string, params: ReadQuery['params'], signal?: AbortSignal, priority: ReadPriority = 'background'): Promise<R[]> {
  try { return poolOf(db, signal).read<R>(sql, params, signal, priority); }
  catch (error) { return Promise.reject(error); }
}

/** Exact host aggregates share the cancellable, prioritized read process with plugin queries. */
export function readHost<R>(db: Db, query: HostRead, signal?: AbortSignal, priority: ReadPriority = 'background'): Promise<R[]> {
  try { return poolOf(db, signal).host<R>(query, signal, priority); }
  catch (error) { return Promise.reject(error); }
}

/** Rollup functions and all their reads execute in the background helper's worker, within one committed snapshot. */
export function computeArchive<R>(db: Db, compute: ReadCompute, signal?: AbortSignal, priority: ReadPriority = 'background'): Promise<R[]> {
  try { return poolOf(db, signal).compute<R>(compute, signal, priority); }
  catch (error) { return Promise.reject(error); }
}

function poolOf(db: Db, signal?: AbortSignal): ArchiveReadPool {
  signal?.throwIfAborted();
  const state = readers.get(db);
  if (!db.open || !state || state.closed) throw new Error('Archive reader is closed');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone !== state.zone) {
    void state.pool?.close();
    state.pool = undefined;
    state.zone = zone;
  }
  if (db.inTransaction) throw new Error('Async archive reads cannot observe an uncommitted transaction');
  if (!state.pool) {
    const { path, diag } = archiveReadEntry();
    state.pool = new ArchiveReadPool({ path: db.name, key: state.key }, path, diag);
  }
  return state.pool;
}
