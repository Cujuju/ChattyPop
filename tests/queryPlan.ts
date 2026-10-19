// Captures the query plans of the statements a read actually runs, with their bound parameters.
import { vi } from 'vitest';
import type { Db } from '../src/core/db';

/** Runs `read`, returning the EXPLAIN QUERY PLAN details of every statement it executed. */
function capturePlans(db: Db): { details: string[]; restore(): void } {
  const prepare = db.prepare.bind(db);
  const details: string[] = [];
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const record = (args: unknown[]): void => {
      const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
      details.push(...rows.map((row) => row.detail));
    };
    const get = statement.get.bind(statement);
    const all = statement.all.bind(statement);
    statement.get = (...args: unknown[]) => {
      record(args);
      return get(...args);
    };
    statement.all = (...args: unknown[]) => {
      record(args);
      return all(...args);
    };
    return statement;
  });
  return { details, restore: () => spy.mockRestore() };
}

export function statementPlans(db: Db, read: () => unknown): string[] {
  const capture = capturePlans(db);
  try { read(); return capture.details; } finally { capture.restore(); }
}

/** Retains instrumentation across awaited query chains. */
export async function readPlans(db: Db, read: () => unknown): Promise<string[]> {
  const capture = capturePlans(db);
  try { await read(); return capture.details; } finally { capture.restore(); }
}
