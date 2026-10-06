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
