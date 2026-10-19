import type { Db } from '../db';

/** A served call may perform at most one display frame of synchronous Core work. */
export const CORE_SYNC_CALL_BUDGET_MS = 16;
/** Lookup exceptions may return at most one small UI page; larger collections belong in the read process. */
export const CORE_SYNC_READ_ROWS_MAX = 64;
/** Exceptions require indexed seeks without aggregates or table enumeration. Row and elapsed budgets fence the returned page. */
export function pointLookup(db: Db, source: string, params: unknown[]): boolean {
  const instructions = db.prepare(`EXPLAIN ${source}`).all(...params) as { opcode: string }[];
  if (instructions.some(({ opcode }) => /^(?:AggStep|Count)$/.test(opcode))) return false;
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as { detail: string }[];
  return !plan.some(({ detail }) => /\bSCAN\b/.test(detail) && !/\b(?:CONSTANT ROW|json_each)\b/.test(detail));
}
