// Host-testing entry re-exports helpers without importing plugin code.
export * from '../helpers';
export * from '../fakeJev';
export * from '../hostRules';
export * from '../pluginReadHarness';

// Host internals plugin tests reach: the test-only host API.
export { claimRun, loadRule, recordOutcome, ruleRows } from '../../src/core/rules/ruleStore';
export { newRuleAction } from '@shared/ruleSpec';
/** The archive's SQLite driver, for a test that writes a database an earlier version left. */
export { default as Database } from 'better-sqlite3-multiple-ciphers';

export { archiveRead } from '../../src/core/plugins/pluginDb';

import type { ArchiveRead, PluginDb } from '../../src/core/plugins/pluginDb';
/** Instrumentable reader for SQL-plan tests; testPlugin uses the real off-thread reader. */
export const statementRead = (db: PluginDb): ArchiveRead => async <R,>(sql: string, params: readonly unknown[] | Record<string, unknown> = [], options = {}) => {
  (options as { signal?: AbortSignal }).signal?.throwIfAborted();
  const statement = db.prepare(sql);
  return (Array.isArray(params) ? statement.all(...params) : statement.all(params)) as R[];
};
