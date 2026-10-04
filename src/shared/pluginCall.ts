// Plugin call results survive transports that discard error properties.

/** A call raced with its plugin stopping; callers may substitute empty data. */
export class PluginInactiveError extends Error {
  constructor(readonly pluginId: string) {
    super(`Plugin ${pluginId} is not active`);
    this.name = 'PluginInactiveError';
  }
}

/** Only inactivity is a returned failure; other errors keep the transport's normal rejection behavior. */
export type PluginCallResult = { status: 'ok'; value: unknown } | { status: 'inactive'; pluginId: string };

/** Encodes a plugin call before it crosses a process or HTTP boundary. */
export async function pluginCallResult(call: () => unknown): Promise<PluginCallResult> {
  try {
    return { status: 'ok', value: await call() };
  } catch (error) {
    if (error instanceof PluginInactiveError) return { status: 'inactive', pluginId: error.pluginId };
    throw error;
  }
}

/** Restores the SDK's typed inactive condition without inspecting error messages. */
export function unwrapPluginCall(result: PluginCallResult): unknown {
  if (result.status === 'inactive') throw new PluginInactiveError(result.pluginId);
  return result.value;
}
