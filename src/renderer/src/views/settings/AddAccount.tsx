// Settings → AI's Add account: another sign-in or API key of a provider, opened from the rail's foot.
import { Show, createSignal } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import type { DeclaredProvider } from '@shared/aiProviders';
import { accountProvider, type AccountAuth } from '@shared/providerAccounts';
import { PROVIDER_DISPLAY_NAME_MAX } from '@shared/settings';
import { availableProviders } from '@/state/aiProviders';
import { aiSettings } from '@/state/preferences';
import { addProviderAccount } from '@/state/providerAccounts';
import { onServerScreen } from '@/state/ui';
import { createAction } from '@/ui/action';
import { ModalDialog } from '@/ui/ModalDialog';
import { Select } from '@/ui/Select';
import { ErrorNote, SettingsButton } from './SettingsLayout';
import styles from './AddAccount.module.css';

const FIRST_ACCOUNT_NUMBER = 1;
/** Why a sign-in can't be added from another computer: its browser sign-in runs on the server. */
const SIGN_IN_ELSEWHERE = 'A sign-in can be added only on the server’s own screen.';

/** What each kind is, and what is left to do in the account's section once it is added. */
const KIND_HINT: Record<AccountAuth, string> = {
  signIn: 'Uses your plan through the provider’s own sign-in. After adding, press Sign in in the account’s section.',
  apiKey: 'Pays per use with a key. After adding, paste it in the account’s section.',
};

const [adding, setAdding] = createSignal(false);

/** Providers that take another account. */
const accountProviders = (): DeclaredProvider[] => availableProviders().filter((p) => !p.account && p.accounts);
export const canAddAccount = (): boolean => accountProviders().length > 0;
export const openAddAccount = (): void => void setAdding(true);

/** The kinds a provider offers that can be added on this screen. */
const addableKinds = (d: DeclaredProvider | undefined): AccountAuth[] => [...(d?.accounts?.signIn && onServerScreen ? ['signIn' as const] : []), ...(d?.apiKey ? ['apiKey' as const] : [])];

/** The first unused "<provider> <n>". */
function nextAccountName(d: DeclaredProvider): string {
  const names = aiSettings().accounts.filter((a) => accountProvider(a.id) === d.id).map((a) => aiSettings().providers[a.id]?.displayName);
  const name = (n: number): string => `${(d.displayName ?? d.id).slice(0, PROVIDER_DISPLAY_NAME_MAX - String(n).length - ' '.length)} ${n}`;
  let number = FIRST_ACCOUNT_NUMBER;
  while (names.includes(name(number))) number++;
  return name(number);
}

/** Mounted once on the page; each opening starts a fresh form. */
export function AddAccountDialog() {
  return (
    <Show when={adding() && canAddAccount()}>
      <AddAccountForm />
    </Show>
  );
}

function AddAccountForm() {
  const close = (): void => void setAdding(false);
  const first = accountProviders()[0]!;
  const [provider, setProvider] = createSignal(first.id);
  const [auth, setAuth] = createSignal<AccountAuth | undefined>(addableKinds(first)[0]);
  const [name, setName] = createSignal(nextAccountName(first));
  const declaration = () => accountProviders().find((p) => p.id === provider());
  const action = createAction();
  const choose = (id: string): void => {
    const d = accountProviders().find((p) => p.id === id);
    if (!d) return;
    setProvider(id);
    setAuth(addableKinds(d)[0]);
    setName(nextAccountName(d));
  };
  const submit = (): void =>
    void action.run(async () => {
      const kind = auth();
      if (!kind) return;
      await addProviderAccount(provider(), kind, name());
      close();
    });
  return (
    <ModalDialog id="add-provider-account" open title="Add account" onClose={close}>
      <form
        class={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p class={styles.lede}>Another sign-in or API key for a provider. Each account gets its own section here, with its own model and usage.</p>
        <label class="cp-field">
          <span class="cp-label">Provider</span>
          <Select value={provider()} options={accountProviders().map((p) => ({ value: p.id, label: p.label }))} onChange={choose} />
        </label>
        <div class="cp-field">
          <span class="cp-label">Connect with</span>
          <SegGroup role="radiogroup" ariaLabel="Connect with" class={styles.kinds} value={auth()} onChange={(v: AccountAuth) => setAuth(v)}>
            <Show when={declaration()?.accounts?.signIn}>
              <SegButton value="signIn" label="Sign in" size="md" disabled={!onServerScreen} />
            </Show>
            <Show when={declaration()?.apiKey}>
              <SegButton value="apiKey" label="API key" size="md" />
            </Show>
          </SegGroup>
          <Show when={auth()}>{(kind) => <span class={styles.hint}>{KIND_HINT[kind()]}</span>}</Show>
          <Show when={declaration()?.accounts?.signIn && !onServerScreen}>
            <span class={styles.hint}>{SIGN_IN_ELSEWHERE}</span>
          </Show>
        </div>
        <label class="cp-field">
          <span class="cp-label">Name</span>
          <input type="text" required autofocus maxlength={PROVIDER_DISPLAY_NAME_MAX} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <span class={styles.hint}>Names its section and its line in Plan usage.</span>
        </label>
        <ErrorNote error={action.error()} />
        <div class="cp-actions">
          <SettingsButton onClick={close}>Cancel</SettingsButton>
          <button class="cp-primary" type="submit" disabled={action.busy() || !name().trim() || !auth()}>
            {action.busy() ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
