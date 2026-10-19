import { measureCoreCall } from '../callStalls';
import { pluginCalls, type PluginCallContext } from './callContext';

export async function servedCall<T>(call: PluginCallContext, fn: () => T): Promise<Awaited<T>> {
  try {
    return await measureCoreCall(call.member, () => pluginCalls.run(call, fn), call.diag, call.plugin);
  } finally { call.completed = true; }
}
