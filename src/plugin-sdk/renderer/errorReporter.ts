import { PAGE_ERROR_MESSAGE_CHARACTERS, PAGE_ERROR_STACK_CHARACTERS, PAGE_ERRORS_PER_LOAD, type PageError } from '@shared/pageErrors';

/** What the reporter listens on: the page's window. */
type ErrorSource = Pick<Window, 'addEventListener'>;

/** Sends uncaught errors and unhandled rejections up to PAGE_ERRORS_PER_LOAD; a failed send is dropped. */
export function errorReporter(source: ErrorSource, now: () => number, send: (report: PageError) => Promise<void>, page: string): void {
  let reported = 0;
  const report = (kind: PageError['kind'], thrown: unknown, described: string): void => {
    if (reported === PAGE_ERRORS_PER_LOAD) return;
    reported++;
    const error = thrown instanceof Error ? thrown : undefined;
    const message = (error ? `${error.name}: ${error.message}` : described).slice(0, PAGE_ERROR_MESSAGE_CHARACTERS);
    void send({ page, at: now(), kind, message, stack: (error?.stack ?? '').slice(0, PAGE_ERROR_STACK_CHARACTERS) }).catch(() => undefined);
  };
  source.addEventListener('error', (e) => report('error', e.error, e.message));
  source.addEventListener('unhandledrejection', (e) => report('rejection', e.reason, String(e.reason)));
}
