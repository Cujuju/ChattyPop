import { api, windowSurface } from './api';
import { PAGE_ERROR_PATH_ATTRIBUTE } from '@shared/pageErrors';
import { errorReporter, pageLoadId } from '@plugin-sdk/renderer/errorReporter';
import { pageFetch } from './pageTransport';

export { pageLoadId };

if (typeof window !== 'undefined') {
  if (windowSurface() === 'desktop') {
    errorReporter(window, () => performance.now(), async (report) => { api.reportPageError(report); }, pageLoadId);
  } else {
    const path = typeof document === 'undefined' ? null : document.documentElement?.getAttribute(PAGE_ERROR_PATH_ATTRIBUTE);
    if (path) {
      errorReporter(window, () => performance.now(), async (report) => {
        await pageFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), keepalive: true, mode: 'same-origin' });
      }, pageLoadId);
    }
  }
}
