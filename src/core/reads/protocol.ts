export interface ReadConnection { path: string; key: string | null }
export interface ReadFold { table: string; keys: string[]; values: Record<string, 'sum' | 'max' | 'min' | 'latest' | 'earliest'>; orderBy?: string }
export interface FoldResult { keys: Record<string, unknown>[]; rows: Record<string, unknown>[] }
export interface ReadCompute { source: string; partition: unknown; data: unknown; fold?: ReadFold }
export type HostRead = { kind: 'directory'; unseen: number; self: string | null; reader: string | null; notable: { sql: string; params: Record<string, unknown> } }
  | { kind: 'unjudged'; now: number; limit: number };
export interface ReadQuery { sql: string; params: readonly unknown[] | Record<string, unknown>; compute?: ReadCompute; host?: HostRead }
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
