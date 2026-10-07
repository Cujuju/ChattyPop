import { MAIN_INVOKE } from '@shared/contract';
import { decodeKeyRouting } from '@shared/openrouter';
import type { CoreClient } from '../coreClient';
import { checkOpenRouterKey, signInToOpenRouter } from '../openrouterAuth';
import { addOpenRouterKey, loadOpenRouterKeys, removeOpenRouterKey, updateOpenRouterKey } from '../openrouterKeys';
import { forgetTypeSafeKey, loadTypeSafeKey, saveTypeSafeKey } from '../typesafeKey';
import { handleMain } from './mainCalls';

/** A string argument from a window or the phone; throws on anything else. */
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new TypeError(`${what} must be a non-empty string`);
  return v;
}

/** Hands core the stored keys, then keeps it current as the renderer adds, edits or removes them. */
export function registerKeyHandlers(core: CoreClient): void {
  const { openRouter, typeSafe } = MAIN_INVOKE;
  // OpenRouter keys are decrypted here (safeStorage is main-only) and held by core in memory; every change is re-sent whole.
  void core.call('setOpenRouterKeys', loadOpenRouterKeys());
  handleMain(openRouter.signIn, async () => core.call('setOpenRouterKeys', addOpenRouterKey(await signInToOpenRouter(), null)));
  handleMain(openRouter.addKey, async (key, routing) =>
    core.call('setOpenRouterKeys', addOpenRouterKey(await checkOpenRouterKey(text(key, 'key')), decodeKeyRouting(routing))),
  );
  handleMain(openRouter.updateKey, (id, routing) => core.call('setOpenRouterKeys', updateOpenRouterKey(text(id, 'id'), decodeKeyRouting(routing))));
  handleMain(openRouter.removeKey, (id) => core.call('setOpenRouterKeys', removeOpenRouterKey(text(id, 'id'))));
  // The TypeSafe key (direct Jev) follows the same rule: decrypted here, held by core in memory.
  void core.call('setTypeSafeKey', loadTypeSafeKey());
  handleMain(typeSafe.setKey, async (key) => core.call('setTypeSafeKey', await saveTypeSafeKey(text(key, 'key'))));
  handleMain(typeSafe.removeKey, () => {
    forgetTypeSafeKey();
    return core.call('setTypeSafeKey', null);
  });
}
