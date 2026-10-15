import { ipcMain, type WebContents } from 'electron';
import { PAGE_ERROR_CHANNEL } from '@shared/contract';
import { pageError } from '@shared/pageErrors';
import { diag, redactIds } from './diagnostics';
import { handleMain } from './ipc/mainCalls';

function reportPageError(window: string, value: unknown): void {
  const report = pageError(value);
  if (report) diag('page-error', { window, ...report, message: redactIds(report.message), stack: redactIds(report.stack) });
}

/** Local windows are named by their sender; the remote allowlist reaches only the remote handler. */
export function registerPageErrors(windowOf: (sender: WebContents) => string | undefined): void {
  ipcMain.on(PAGE_ERROR_CHANNEL, (e, report: unknown) => {
    const window = windowOf(e.sender);
    if (window) reportPageError(window, report);
  });
  handleMain(PAGE_ERROR_CHANNEL, (report) => reportPageError('remote', report));
}
