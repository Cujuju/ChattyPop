import { MAIN_INVOKE } from '@shared/contract';
import { decodeKeyRouting } from '@shared/openrouter';
import type { CoreClient } from '../coreClient';
import { checkOpenRouterKey, signInToOpenRouter } from '../openrouterAuth';
import { addOpenRouterKey, removeOpenRouterKey, updateOpenRouterKey } from '../openrouterKeys';
import { forgetTypeSafeKey, saveTypeSafeKey } from '../typesafeKey';
import { forgetProviderKey, forgetProxyKey, saveProviderKey, saveProxyKey } from '../providerKeys';
import { requireSecretStorage, SECRET_FILES } from '../secretFile';
import { handleMain } from './mainCalls';

/** A string argument from a window or the phone; throws on anything else. */
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new TypeError(`${what} must be a non-empty string`);
  return v;
}

/** Keeps core's keys current as the renderer adds, edits or removes them; core starts with the stored ones (CoreInit). */
export function registerKeyHandlers(core: CoreClient): void {
  const { openRouter, typeSafe, providerKeys } = MAIN_INVOKE;
  // OpenRouter keys are decrypted here (safeStorage is main-only) and held by core in memory; every change is re-sent whole.
  handleMain(openRouter.signIn, async () => core.call('setOpenRouterKeys', addOpenRouterKey(await signInToOpenRouter(), null)));
  handleMain(openRouter.addKey, async (key, routing) =>
    core.call('setOpenRouterKeys', addOpenRouterKey(await checkOpenRouterKey(text(key, 'key')), decodeKeyRouting(routing))),
  );
  handleMain(openRouter.updateKey, (id, routing) => core.call('setOpenRouterKeys', updateOpenRouterKey(text(id, 'id'), decodeKeyRouting(routing))));
  handleMain(openRouter.removeKey, (id) => core.call('setOpenRouterKeys', removeOpenRouterKey(text(id, 'id'))));
  // The TypeSafe key (direct Jev) follows the same rule: decrypted here, held by core in memory.
  handleMain(typeSafe.setKey, async (key) => core.call('setTypeSafeKey', await saveTypeSafeKey(text(key, 'key'))));
  handleMain(typeSafe.removeKey, () => {
    forgetTypeSafeKey();
    return core.call('setTypeSafeKey', null);
  });
  handleMain(providerKeys.setKey, async (id, raw) => {
    const providerId = text(id, 'provider id');
    const key = text(raw, 'key').trim();
    if (!key) throw new Error('Paste an API key.');
    requireSecretStorage();
    await core.call('checkProviderApiKey', providerId, key);
    return core.call('setProviderApiKeys', saveProviderKey(SECRET_FILES, providerId, key));
  });
  handleMain(providerKeys.removeKey, (id) => core.call('setProviderApiKeys', forgetProviderKey(SECRET_FILES, text(id, 'provider id'))));
  handleMain(providerKeys.setProxyKey, (raw) => {
    requireSecretStorage();
    return core.call('setProxyKey', saveProxyKey(SECRET_FILES, text(raw, 'key')));
  });
  handleMain(providerKeys.removeProxyKey, () => {
    forgetProxyKey(SECRET_FILES);
    return core.call('setProxyKey', null);
  });
}
