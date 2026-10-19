import { performance } from 'node:perf_hooks';
import { activePluginCall, checkSyncRead, pluginCalls } from './callContext';
import { CORE_SYNC_CALL_BUDGET_MS } from './syncReadBudget';
import type { HostDeps } from './api';

/** Eight messages leave room for multiple indexed part rows under the 64-row statement budget. */
const DECORATION_IDS_PER_BATCH = 8;
const DECORATION_SYNC_READS = { reason: 'Indexed live decoration of a bounded archive page batch.' };

/** The host declares the lookup exception for synchronous decoration providers, including on host pages. */
export function decorationReads<K, V>(plugin: string, member: string, deps: Pick<HostDeps, 'diag' | 'strictSyncReads'>,
  ids: string[], fn: (ids: string[]) => Map<K, V>): Map<K, V> {
  const call = activePluginCall();
  return pluginCalls.run({ ...call, plugin, member, reads: false, diagnosed: false, syncReads: DECORATION_SYNC_READS,
    signal: call?.signal ?? new AbortController().signal, priority: call?.priority ?? 'interactive',
    strict: call?.strict ?? deps.strictSyncReads ?? !!process.env.VITEST, diag: deps.diag ?? call?.diag ?? (() => undefined),
  }, () => {
    const out = new Map<K, V>();
    for (let offset = 0; offset < ids.length; offset += DECORATION_IDS_PER_BATCH) {
      const start = performance.now();
      const own = fn(ids.slice(offset, offset + DECORATION_IDS_PER_BATCH));
      if (performance.now() - start > CORE_SYNC_CALL_BUDGET_MS) checkSyncRead(false);
      for (const [key, value] of own) out.set(key, value);
    }
    return out;
  });
}
