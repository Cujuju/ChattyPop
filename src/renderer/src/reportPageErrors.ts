import { api, windowSurface } from './api';
import { errorReporter } from '@plugin-sdk/renderer/errorReporter';

if (typeof window !== 'undefined' && windowSurface() !== 'phone') {
  errorReporter(window, () => performance.now(), (report) => Promise.resolve(api.reportPageError(report)), crypto.randomUUID());
}
