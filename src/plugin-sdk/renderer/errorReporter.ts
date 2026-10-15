import { PAGE_ERROR_MESSAGE_CHARACTERS, PAGE_ERROR_STACK_CHARACTERS, PAGE_ERRORS_PER_LOAD, type PageError } from '@shared/pageErrors';

/** One host-owned id for this load's errors and timing batches. */
export const pageLoadId = crypto.randomUUID();

/** What the reporter listens on: the page's window. */
type ErrorSource = Pick<Window, 'addEventListener'>;

/** Sends each thrown object once, up to PAGE_ERRORS_PER_LOAD; primitives repeat and a failed send is dropped. */
export function errorReporter(source: ErrorSource, now: () => number, send: (report: PageError) => Promise<void>, page: string): void {
  let reported = 0;
  const objects = new WeakSet<object>();
  const report = (kind: PageError['kind'], thrown: unknown, described: string): void => {
    const object = thrown !== null && (typeof thrown === 'object' || typeof thrown === 'function') ? thrown : undefined;
    if (object && objects.has(object)) return;
    if (reported === PAGE_ERRORS_PER_LOAD) return;
    if (object) objects.add(object);
    reported++;
    const error = thrown instanceof Error ? thrown : undefined;
    const message = (error ? `${error.name}: ${error.message}` : described).slice(0, PAGE_ERROR_MESSAGE_CHARACTERS);
    void send({ page, at: now(), kind, message, stack: (error?.stack ?? '').slice(0, PAGE_ERROR_STACK_CHARACTERS) }).catch(() => undefined);
  };
  source.addEventListener('error', (e) => report('error', e.error, e.message));
  source.addEventListener('unhandledrejection', (e) => report('rejection', e.reason, String(e.reason)));
}
