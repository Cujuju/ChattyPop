import { For, Show, createSignal } from 'solid-js';
import { accountProvider, type AccountAuth } from '@shared/providerAccounts';
import { PROVIDER_DISPLAY_NAME_MAX } from '@shared/settings';
import { availableProviders } from '@/state/aiProviders';
import { aiSettings } from '@/state/preferences';
import { addProviderAccount } from '@/state/providerAccounts';
import { onServerScreen } from '@/state/ui';
import { createAction } from '@/ui/action';
import { ModalDialog } from '@/ui/ModalDialog';
import { ErrorNote, Note, SettingsButton, settingsControl as c } from './SettingsLayout';

const FIRST_ACCOUNT_NUMBER = 1;

/** Adds an account using the existing modal and form controls. */
export function AddAccount() {
  const providers = () => availableProviders().filter((p) => !p.account && p.accounts);
  const [open, setOpen] = createSignal(false);
  const [provider, setProvider] = createSignal('');
  const [auth, setAuth] = createSignal<AccountAuth>('signIn');
  const [name, setName] = createSignal('');
  const declaration = () => providers().find((p) => p.id === provider());
  const action = createAction();
  const choose = (id: string): void => {
    setProvider(id);
    const d = providers().find((p) => p.id === id);
    setAuth(d?.accounts?.signIn ? 'signIn' : 'apiKey');
    let number = FIRST_ACCOUNT_NUMBER;
    const names = aiSettings().accounts.filter((a) => accountProvider(a.id) === id).map((a) => aiSettings().providers[a.id]?.displayName);
    const nextName = (): string => `${(d?.displayName ?? id).slice(0, PROVIDER_DISPLAY_NAME_MAX - String(number).length - ' '.length)} ${number}`;
    while (names.includes(nextName())) number++;
    setName(nextName());
  };
  return <Show when={providers().length}>
    <SettingsButton onClick={() => { choose(providers()[0]!.id); setOpen(true); }}>+ Add account</SettingsButton>
    <Show when={open()}>
      <ModalDialog id="add-provider-account" open title="Add account" onClose={() => setOpen(false)}>
        <form onSubmit={(e) => { e.preventDefault(); void action.run(async () => {
          if (auth() === 'signIn' && !onServerScreen) throw new Error('Add a sign-in account on the server’s own screen.');
          await addProviderAccount(provider(), auth(), name()); setOpen(false);
        }); }}>
          <label class="cp-field"><span class="cp-label">Provider</span>
            <select class={c.select} value={provider()} onChange={(e) => choose(e.currentTarget.value)}>
              <For each={providers()}>{(p) => <option value={p.id}>{p.label}</option>}</For>
            </select>
          </label>
          <label class="cp-field"><span class="cp-label">Kind</span>
            <select class={c.select} value={auth()} onChange={(e) => setAuth(e.currentTarget.value as AccountAuth)}>
              <Show when={declaration()?.accounts?.signIn}><option value="signIn">Sign in</option></Show>
              <Show when={declaration()?.apiKey}><option value="apiKey">API key</option></Show>
            </select>
          </label>
          <label class="cp-field"><span class="cp-label">Name</span>
            <input class={c.select} required maxlength={PROVIDER_DISPLAY_NAME_MAX} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <Show when={!onServerScreen}><Note>Sign-in accounts must be added on the server’s own screen. API keys can be added here.</Note></Show>
          <ErrorNote error={action.error()} />
          <div class="cp-actions">
            <SettingsButton onClick={() => setOpen(false)}>Cancel</SettingsButton>
            <button class="cp-primary" type="submit" disabled={action.busy() || !name().trim() || (auth() === 'signIn' && !onServerScreen)}>Add account</button>
          </div>
        </form>
      </ModalDialog>
    </Show>
  </Show>;
}
