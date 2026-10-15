/** A page's uncaught errors, as it reports them to diagnostics. */
export const PAGE_ERROR_MESSAGE_CHARACTERS = 500;
/** Room for some twenty frames of a dev build's unbundled URLs. */
export const PAGE_ERROR_STACK_CHARACTERS = 4000;
/** Reports one page load sends: an error repeating on every key fills neither the log nor the network. */
export const PAGE_ERRORS_PER_LOAD = 20;

export interface PageError {
  /** The page load, as its timing batches name it. */
  page: string;
  /** When, in ms on the page's monotonic timeline (as timing entries' startTime). */
  at: number;
  /** An uncaught exception, or a promise rejection nothing handled. */
  kind: 'error' | 'rejection';
  message: string;
  /** Empty when what was thrown carried none. */
  stack: string;
}

/** Validates the bounded wire contract before logging a page report. */
export function pageError(value: unknown): PageError | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as PageError;
  if (typeof e.page !== 'string' || !/^[a-f0-9-]{36}$/.test(e.page) || !Number.isFinite(e.at) || e.at < 0
    || (e.kind !== 'error' && e.kind !== 'rejection')
    || typeof e.message !== 'string' || e.message.length > PAGE_ERROR_MESSAGE_CHARACTERS
    || typeof e.stack !== 'string' || e.stack.length > PAGE_ERROR_STACK_CHARACTERS) return null;
  return { page: e.page, at: e.at, kind: e.kind, message: e.message, stack: e.stack };
}
