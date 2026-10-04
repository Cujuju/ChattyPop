// Renderer data reads tolerate a plugin stopping before its change event arrives.
import { PluginInactiveError } from '@shared/pluginCall';

/** Resolves inactive plugin reads to the supplied fallback; all other failures still reject. */
export async function pluginData<T, F>(read: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PluginInactiveError) return fallback;
    throw error;
  }
}
