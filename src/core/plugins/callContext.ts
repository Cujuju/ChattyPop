import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallContext } from '@shared/readPriority';

export interface PluginCallContext extends CallContext {
  plugin: string;
  member: string;
  reads: boolean;
  syncReads?: { readonly reason: string };
  diagnosed?: boolean;
  strict: boolean;
  /** Shared by contexts that refine the signal; object spread must not freeze the call's active state. */
  completion?: { done: boolean };
  diag(event: string, detail: Record<string, unknown>): void;
}
export const pluginCalls = new AsyncLocalStorage<PluginCallContext>();

/** Detached work may inherit an ALS store, but it is no longer owned by a completed served call. */
export function activePluginCall(): PluginCallContext | undefined {
  const call = pluginCalls.getStore();
  return call?.completion?.done ? undefined : call;
}

export function currentCall(): CallContext {
  const call = activePluginCall();
  if (!call) throw new Error('channels.call() requires a served core call');
  return { signal: call.signal, priority: call.priority };
}

/** Execution-time checks also cover statements and iterators prepared before the call. */
export function checkSyncRead(bounded = false): void {
  const call = activePluginCall();
  if (!call || (!call.reads && call.syncReads && bounded)) return;
  if (!call.diagnosed) {
    call.diagnosed = true;
    call.diag('plugin-sync-read', { plugin: call.plugin, member: call.member });
  }
  if (call.strict) throw new Error(`plugin-sync-read: ${call.plugin}.${call.member} must use ctx.storage.read`);
}
