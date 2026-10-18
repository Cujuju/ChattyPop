export interface ReadConnection { path: string; key: string | null }
export interface ReadQuery { sql: string; params: readonly unknown[] | Record<string, unknown> }
export type ReadReply = { kind: 'started' } | { kind: 'rows'; rows: unknown[] } | { kind: 'error'; message: string; code?: string; fatal?: boolean };

/** Whitespace, SQL comments and empty statements skipped by SQLite. */
const TRIVIA = String.raw`(?:\s|--[^\n]*(?:\n|$)|/\*[\s\S]*?(?:\*/|$)|;)*`;
/** Connection controls can act during preparation; reject before preparing on either connection. */
const CONNECTION_KEYWORDS = ['pragma', 'attach', 'detach', 'begin', 'commit', 'end', 'rollback', 'savepoint', 'release', 'vacuum'];
const CONNECTION_STATEMENT = new RegExp(
  String.raw`^${TRIVIA}(?:explain\b${TRIVIA}(?:query\b${TRIVIA}plan\b${TRIVIA})?)?(?:${CONNECTION_KEYWORDS.join('|')})\b`, 'i',
);

export function checkReadStatement(sql: string): void {
  if (CONNECTION_STATEMENT.test(sql)) throw new Error('Plugins may not run statements that change the shared connection');
}
