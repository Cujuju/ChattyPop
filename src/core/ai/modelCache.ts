// A provider's model list kept for the session: listing some providers' models spawns their CLI, which is slow.
import type { ModelOption } from './types';

/** Lists once, then answers from memory until a refresh; a failed listing is not kept. */
export function sessionModels(list: () => Promise<ModelOption[]>): (refresh: boolean) => Promise<ModelOption[]> {
  let kept: Promise<ModelOption[]> | null = null;
  return async (refresh) => {
    if (refresh) kept = null;
    const listing = kept ??= Promise.resolve().then(list);
    try {
      return await listing;
    } catch (err) {
      if (kept === listing) kept = null;
      throw err;
    }
  };
}
