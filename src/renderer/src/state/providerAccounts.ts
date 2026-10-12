import { createSignal } from 'solid-js';
import { api } from '@/api';
import type { AppEvent } from '@shared/contract';
import { accountKey, newAccountId, type AccountAuth } from '@shared/providerAccounts';
import { declaredProvider } from '@shared/aiProviders';
import { normalizeDisplayName, type ProviderId } from '@shared/settings';
import { onAppEvent } from './events';
import { aiSettings, patchAiSettings, providerSettingsOf, refetchProviderStatus } from './preferences';
import { onServerScreen, setSettingsSections, settingsSections } from './ui';

type Link = Extract<AppEvent, { type: 'account-link' }>;
const [links, setLinks] = createSignal<Record<ProviderId, Link>>({});
const opened = new Map<ProviderId, string>();
export const accountLink = (id: ProviderId): Link | undefined => links()[id];
onAppEvent('account-link', (event) => {
  if (event.type !== 'account-link') return;
  setLinks((old) => ({ ...old, [event.id]: event }));
  if (event.state === 'waiting' && !event.url) opened.delete(event.id);
  if (onServerScreen && event.state === 'waiting' && event.url && !event.opened && opened.get(event.id) !== event.url) {
    opened.set(event.id, event.url);
    Object.assign(document.createElement('a'), { href: event.url, target: '_blank', rel: 'noreferrer' }).click();
  }
  if (event.state === 'done') void refetchProviderStatus();
});

/** A declared provider's stored choices with its switch set. */
const switched = (id: ProviderId, enabled: boolean) => ({ providers: { ...aiSettings().providers, [id]: { ...providerSettingsOf(id), enabled } } });

/** Adds a declared provider itself (its own sign-in or server), with the choices it last had. */
export async function addProvider(id: ProviderId): Promise<void> {
  if (accountKey(id) || !declaredProvider(id)) throw new Error('This provider cannot be added here.');
  await patchAiSettings(switched(id, true));
  await setSettingsSections({ ...settingsSections(), ai: id });
  await refetchProviderStatus();
}

/** Removes what the owner added: an account with its sign-in or key, or a declared provider, whose choices are kept. */
export async function removeProvider(id: ProviderId): Promise<void> {
  if (accountKey(id)) return removeProviderAccount(id);
  await patchAiSettings(switched(id, false));
  await refetchProviderStatus();
}

export async function addProviderAccount(provider: ProviderId, auth: AccountAuth, name: string): Promise<void> {
  const declared = declaredProvider(provider);
  if (!declared?.accounts || (auth === 'signIn' ? !declared.accounts.signIn || !onServerScreen : auth !== 'apiKey' || !declared.apiKey))
    throw new Error('This account kind cannot be added here.');
  const displayName = normalizeDisplayName(name);
  if (!displayName) throw new Error('Name this account.');
  const ai = aiSettings();
  const id = newAccountId(provider, Object.keys(ai.providers));
  await patchAiSettings({ accounts: [...ai.accounts, { id, auth }], providers: { ...ai.providers, [id]: { enabled: true, displayName, model: null, effort: null } } });
  await setSettingsSections({ ...settingsSections(), ai: id });
  await refetchProviderStatus();
}

async function removeProviderAccount(id: ProviderId): Promise<void> {
  const account = aiSettings().accounts.find((a) => a.id === id);
  if (!account) return;
  if (account.auth === 'apiKey') await api.providerKeys.removeKey(id);
  else if (onServerScreen) await api.core.cancelAccountLink(id);
  const ai = aiSettings();
  const providers = { ...ai.providers };
  delete providers[id];
  await patchAiSettings({ accounts: ai.accounts.filter((a) => a.id !== id), providers });
  setLinks((old) => { const next = { ...old }; delete next[id]; return next; });
  await refetchProviderStatus();
}
