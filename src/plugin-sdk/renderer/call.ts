import { api } from '@/api';
import { unwrapPluginCall } from '@shared/pluginCall';
import { currentCallOptions, type CallOptions } from './callOptions';

export { withCallOptions, type CallOptions } from './callOptions';

export function callCore(plugin: string, member: string, args: unknown[], options: CallOptions = currentCallOptions() ?? {}): Promise<unknown> {
  const { signal, priority = 'background' } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(signal!.reason);
      try { void api.plugins.cancelCore(plugin, id).catch(() => undefined); } catch { /* The transport may have closed with the window. */ }
    };
    signal?.addEventListener('abort', abort, { once: true });
    let work: ReturnType<typeof api.plugins.callCore>;
    try { work = api.plugins.callCore(plugin, member, args, { id, priority }); }
    catch (error) { signal?.removeEventListener('abort', abort); reject(error); return; }
    work.then((reply) => { if (!signal?.aborted) resolve(unwrapPluginCall(reply)); }, reject)
      .catch(reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
