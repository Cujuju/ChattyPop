// No imports: tests set the entry before their module mocks load the pool.
export type ReadDiag = (event: string, detail: Record<string, unknown>) => void;
export interface HelperEntry { path: string; diag?: ReadDiag }
let configured: HelperEntry | undefined;

/** Core's build entry names the helper: bundling may move the reader modules into a shared chunk folder. */
export function setArchiveReadEntry(path: string, diag?: ReadDiag): void {
  configured = { path, diag };
}

export function archiveReadEntry(): HelperEntry {
  if (!configured) throw new Error('Archive read helper entry is not configured');
  return configured;
}
