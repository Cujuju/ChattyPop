import { ipcMain } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import type { OpenRouterKeyRouting } from '@shared/openrouter';
import type { CoreClient } from '../coreClient';
import { checkOpenRouterKey, signInToOpenRouter } from '../openrouterAuth';
import { addOpenRouterKey, loadOpenRouterKeys, removeOpenRouterKey, updateOpenRouterKey } from '../openrouterKeys';
import { forgetTypeSafeKey, loadTypeSafeKey, saveTypeSafeKey } from '../typesafeKey';

/** Hands core the stored keys, then keeps it current as the renderer adds, edits or removes them. */
export function registerKeyHandlers(core: CoreClient): void {
  const { openRouter, typeSafe } = MAIN_INVOKE;
  // OpenRouter keys are decrypted here (safeStorage is main-only) and held by core in memory; every change is re-sent whole.
  void core.call('setOpenRouterKeys', loadOpenRouterKeys());
  ipcMain.handle(openRouter.signIn, async () => core.call('setOpenRouterKeys', addOpenRouterKey(await signInToOpenRouter(), null)));
  ipcMain.handle(openRouter.addKey, async (_e, key: string, routing: OpenRouterKeyRouting) =>
    core.call('setOpenRouterKeys', addOpenRouterKey(await checkOpenRouterKey(key), routing)),
  );
  ipcMain.handle(openRouter.updateKey, (_e, id: string, routing: OpenRouterKeyRouting) => core.call('setOpenRouterKeys', updateOpenRouterKey(id, routing)));
  ipcMain.handle(openRouter.removeKey, (_e, id: string) => core.call('setOpenRouterKeys', removeOpenRouterKey(id)));
  // The TypeSafe key (direct Jev) follows the same rule: decrypted here, held by core in memory.
  void core.call('setTypeSafeKey', loadTypeSafeKey());
  ipcMain.handle(typeSafe.setKey, async (_e, key: string) => core.call('setTypeSafeKey', await saveTypeSafeKey(key)));
  ipcMain.handle(typeSafe.removeKey, () => {
    forgetTypeSafeKey();
    return core.call('setTypeSafeKey', null);
  });
}
