import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { pageError } from '@shared/pageErrors';
import { buildContainment } from './containmentBuild';

afterEach(() => vi.unstubAllGlobals());

it('posts an eager remote failure with the real API leaf before any transport installs', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const received = vi.fn();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received(req.url, req.method, pageError(JSON.parse(Buffer.concat(chunks).toString())));
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const nativeFetch = fetch;
  const sends: Promise<Response>[] = [];
  const post = vi.fn((path: string, init: RequestInit) => {
    const sent = nativeFetch(new URL(path, `http://127.0.0.1:${port}`), init);
    sends.push(sent);
    return sent;
  });
  vi.stubGlobal('fetch', post);
  vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) });
  vi.stubGlobal('document', { documentElement: { dataset: { surface: 'remote' }, getAttribute: () => '/errors' } });
  try {
    const client: { boot(): Promise<void>; installApi(api: unknown): void } = await buildContainment(`
      import '@/reportPageErrors';
      export { installApi } from '@/api';
      export const boot = () => import('@plugin-sdk/renderer/shell/remoteApi');
    `, {
      '@/ui/exportPage': `throw new Error('Import-time remote failure'); export const setPageOpener = () => {};`,
      '@shared/remote': `export const SERVER_SCREEN_CORE_METHODS = [];`,
      '@/boot': `export const startApp = () => {};`,
    });
    let failure: unknown;
    try { await client.boot(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: 'Import-time remote failure' });
    expect(listeners.has('error')).toBe(true);
    listeners.get('error')!({ error: failure, message: '' });
    await Promise.all(sends);
    expect(post).toHaveBeenCalledExactlyOnceWith('/errors', expect.objectContaining({
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true, mode: 'same-origin',
    }));
    expect(received).toHaveBeenCalledExactlyOnceWith('/errors', 'POST', expect.objectContaining({ message: 'Error: Import-time remote failure' }));
    const late = vi.fn();
    client.installApi({ reportPageError: late });
    expect(late).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
