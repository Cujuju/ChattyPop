import { api } from '@/api';
import { unwrapPluginCall } from '@shared/pluginCall';
import type { ReadPriority } from '@shared/readPriority';

/** Bind gate signals explicitly for calls made after an await; resources bind their own signal. */
export interface CallOptions { signal?: AbortSignal; priority?: ReadPriority }
let current: CallOptions | undefined;

/** Captures calls issued synchronously by an archive gate, without retaining mutable state across awaits. */
export function withCallOptions<T>(options: CallOptions, run: () => T): T {
  const previous = current;
  current = options;
  try { return run(); } finally { current = previous; }
}

export function callCore(plugin: string, member: string, args: unknown[], options: CallOptions = current ?? {}): Promise<unknown> {
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
