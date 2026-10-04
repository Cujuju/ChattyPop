// A provider's model list kept for the session: listing some providers' models spawns their CLI, which is slow.
import type { ModelOption } from './types';

/** Lists once, then answers from memory until a refresh; a failed listing is not kept. */
export function sessionModels(list: () => Promise<ModelOption[]>): (refresh: boolean) => Promise<ModelOption[]> {
  let kept: ModelOption[] | null = null;
  return async (refresh) => {
    if (refresh) kept = null;
    kept ??= await list();
    return kept;
  };
}
