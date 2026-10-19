import { measureCoreCall } from '../callStalls';
import { pluginCalls, type PluginCallContext } from './callContext';

export async function servedCall<T>(call: PluginCallContext, fn: () => T): Promise<Awaited<T>> {
  const completion: { done: boolean } = { done: false };
  call.completion = completion;
  try {
    return await measureCoreCall(call.member, () => pluginCalls.run(call, fn), call.diag, call.plugin);
  } finally { completion.done = true; }
}
