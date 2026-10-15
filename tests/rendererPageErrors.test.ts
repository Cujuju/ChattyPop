import { afterEach, expect, it, vi } from 'vitest';
import { buildContainment } from './containmentBuild';

afterEach(() => vi.unstubAllGlobals());

it.each(['registry', 'boot', 'remote', 'page'])('forwards an import-time %s failure after installing the reporter', async (graph) => {
  const listeners = new Map<string, (event: unknown) => void>();
  const send = vi.fn();
  vi.stubGlobal('window', {
    reportPageError: send,
    ...(['remote', 'page'].includes(graph) ? {} : { chattypop: { reportPageError: send } }),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
  });
  vi.stubGlobal('document', { documentElement: { dataset: { surface: 'remote' } } });
  const fail = `throw new Error('Import-time ${graph} failure');`;
  const desktop = {
    './theme/index.css': '',
    './plugins/bundled': graph === 'registry' ? fail : '',
    './boot': `${graph === 'boot' ? fail : ''} export const startApp = () => {};`,
  };
  const source = graph === 'remote'
    ? `export { startRemoteDesktop } from '@plugin-sdk/renderer/shell/remoteApi';`
    : graph === 'page' ? `import '@/plugins/page';` : `import '@/main';`;
  let failure: unknown;
  const api = `
    export const api = { reportPageError: report => window.reportPageError(report) };
    export const windowSurface = () => window.chattypop ? 'desktop' : 'remote';
    export const installApi = () => {};
  `;
  try {
    await buildContainment(source, {
      './api': api, '@/api': api,
      ...(graph === 'remote' ? {
        '@/ui/exportPage': `${fail} export const setPageOpener = () => {};`,
        '@/boot': 'export const startApp = () => {};',
        '@shared/remote': 'export const SERVER_SCREEN_CORE_METHODS = [];',
      } : graph === 'page' ? { '../theme/index.css': '', './bundled': fail } : desktop),
    });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message: `Import-time ${graph} failure` });
  listeners.get('error')?.({ error: failure, message: '' });
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'error', message: `Error: Import-time ${graph} failure` }));
});
