import { afterEach, expect, it, vi } from 'vitest';
import { buildContainment } from './containmentBuild';

afterEach(() => vi.unstubAllGlobals());

it.each(['registry', 'boot', 'remote', 'page', 'installed'])('reports an import-time %s failure once with the real API leaf', async (graph) => {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const ipc = vi.fn();
  const post = vi.fn(async (_path: string, _init: RequestInit) => new Response());
  const preload = graph === 'registry' || graph === 'boot';
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('window', {
    ...(preload ? { chattypop: { reportPageError: ipc } } : {}),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, [...listeners.get(name) ?? [], listener]),
  });
  vi.stubGlobal('document', { documentElement: { dataset: { surface: 'remote' }, getAttribute: () => '/errors' } });
  const fail = `throw new Error('Import-time ${graph} failure');`;
  const desktop = {
    './theme/index.css': '',
    './plugins/bundled': graph === 'registry' ? fail : '',
    './boot': `${graph === 'boot' ? fail : ''} export const startApp = () => {};`,
  };
  const source = graph === 'remote'
    ? `export { startRemoteDesktop } from '@plugin-sdk/renderer/shell/remoteApi';`
    : graph === 'page' ? `import '@/plugins/page';`
      : graph === 'installed' ? `import '@/plugins/installedPage';` : `import '@/main';`;
  let failure: unknown;
  try {
    await buildContainment(source, graph === 'remote' ? {
      '@/ui/exportPage': `${fail} export const setPageOpener = () => {};`,
      '@/boot': 'export const startApp = () => {};',
      '@shared/remote': 'export const SERVER_SCREEN_CORE_METHODS = [];',
    } : graph === 'page' || graph === 'installed' ? { '../theme/index.css': '', './bundled': fail } : desktop);
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message: `Import-time ${graph} failure` });
  expect(listeners.get('error')).toHaveLength(1);
  expect(listeners.get('unhandledrejection')).toHaveLength(1);
  listeners.get('error')![0]!({ error: failure, message: '' });
  if (preload) {
    expect(ipc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'error', message: `Error: Import-time ${graph} failure` }));
    expect(post).not.toHaveBeenCalled();
  } else {
    expect(post).toHaveBeenCalledOnce();
    expect(JSON.parse(post.mock.calls[0]![1].body as string)).toMatchObject({ kind: 'error', message: `Error: Import-time ${graph} failure` });
    expect(ipc).not.toHaveBeenCalled();
  }
});

it.each(['companion', 'remote'])('shares one reporter and load id on the %s surface', async (surface) => {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const post = vi.fn(async (_path: string, _init: RequestInit) => new Response());
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, [...listeners.get(name) ?? [], listener]) });
  vi.stubGlobal('document', { documentElement: { dataset: { surface }, getAttribute: () => '/errors' } });
  const client: { pageLoadId: string } = await buildContainment(`
    import '@/plugins/page';
    import '@/reportPageErrors';
    export { pageLoadId } from '@plugin-sdk/renderer';
  `, {
    '../theme/index.css': '', './bundled': '',
    'virtual:bundled-plugins/shared': 'export default []; export const catalog = null;',
    'virtual:installed-plugins/shared': 'export default [];',
  });
  expect(listeners.get('error')).toHaveLength(1);
  expect(listeners.get('unhandledrejection')).toHaveLength(1);
  listeners.get('error')![0]!({ error: new Error('once'), message: '' });
  expect(post).toHaveBeenCalledOnce();
  expect(JSON.parse(post.mock.calls[0]![1].body as string).page).toBe(client.pageLoadId);
});

it('installs no reporter without a preload or error route', async () => {
  const addEventListener = vi.fn();
  vi.stubGlobal('window', { addEventListener });
  vi.stubGlobal('document', { documentElement: { dataset: {}, getAttribute: () => null } });
  await buildContainment(`import '@/reportPageErrors';`);
  expect(addEventListener).not.toHaveBeenCalled();
});

it.each(['https://elsewhere.example/errors', '//elsewhere.example/errors', 'errors'])('drops an error route outside the path guard: %s', async (path) => {
  const listeners = new Map<string, (event: unknown) => void>();
  const post = vi.fn();
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) });
  vi.stubGlobal('document', { documentElement: { dataset: {}, getAttribute: () => path } });
  await buildContainment(`import '@/reportPageErrors';`);
  expect(() => listeners.get('error')!({ error: new Error('lost'), message: '' })).not.toThrow();
  await Promise.resolve();
  expect(post).not.toHaveBeenCalled();
});

it('drops a failed route send without retrying it through an installed API', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const post = vi.fn(async () => { throw new Error('offline'); });
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) });
  vi.stubGlobal('document', { documentElement: { dataset: {}, getAttribute: () => '/errors' } });
  const client: { installApi(api: unknown): void } = await buildContainment(`import '@/reportPageErrors'; export { installApi } from '@/api';`);
  listeners.get('error')!({ error: new Error('lost'), message: '' });
  await Promise.resolve();
  const late = vi.fn();
  client.installApi({ reportPageError: late });
  expect(post).toHaveBeenCalledOnce();
  expect(late).not.toHaveBeenCalled();
});
