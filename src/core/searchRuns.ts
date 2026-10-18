// Archive searches run in an archive read helper, so a long scan leaves core free; a caller's newer search cancels its older one.
import type { SearchHit } from '@shared/contract';
import type { SearchSort } from '@shared/searchQuery';
import type { Db } from './db';
import { searchStatement, type HitRow } from './queries/search';
import { readArchive } from './reads/archiveReads';

/** Each caller's search in flight, by the key it searches under. */
const running = new Map<string, AbortController>();

/**
 * searchStatement read off the core thread. A newer search under `caller` aborts this one (its helper stops), which then
 * rejects; a search with no caller (a client built before the key) is never cancelled.
 */
export async function searchOffThread(db: Db, text: string, limit: number, sort: SearchSort, caller: string | null): Promise<SearchHit[]> {
  const controller = new AbortController();
  if (caller !== null) {
    running.get(caller)?.abort(new Error('A newer search replaced this one'));
    running.set(caller, controller);
  }
  try {
    const s = searchStatement(text, limit, sort);
    return s ? s.hits(await readArchive<HitRow>(db, s.sql, s.params, controller.signal)) : [];
  } finally {
    if (caller !== null && running.get(caller) === controller) running.delete(caller);
  }
}
