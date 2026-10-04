// Captures the query plans of the statements a read actually runs, with their bound parameters.
import { vi } from 'vitest';
import type { Db } from '../src/core/db';

/** Runs `read`, returning the EXPLAIN QUERY PLAN details of every statement it executed. */
export function statementPlans(db: Db, read: () => unknown): string[] {
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
  try {
    read();
  } finally {
    spy.mockRestore();
  }
  return details;
}
