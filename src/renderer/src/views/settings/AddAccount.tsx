// Settings → AI's Add account: a provider itself, or another sign-in or API key of one, opened from the rail's foot.
import { Show, createSignal } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import type { DeclaredProvider } from '@shared/aiProviders';
import { accountProvider, type ProviderAuth } from '@shared/providerAccounts';
import { PROVIDER_DISPLAY_NAME_MAX } from '@shared/settings';
import { offeredProviders, providerAdded } from '@/state/aiProviders';
import { aiSettings } from '@/state/preferences';
import { addProvider, addProviderAccount } from '@/state/providerAccounts';
import { onServerScreen } from '@/state/ui';
import { createAction } from '@/ui/action';
import { ModalDialog } from '@/ui/ModalDialog';
import { Select } from '@/ui/Select';
import { ErrorNote, SettingsButton } from './SettingsLayout';
import styles from './AddAccount.module.css';

const FIRST_ACCOUNT_NUMBER = 1;
/** Why a sign-in can't be added from another computer: its browser sign-in runs on the server. */
const SIGN_IN_ELSEWHERE = 'A sign-in can be added only on the server’s own screen.';
/** Where a provider's own sign-in lives, as this screen calls it. */
const OWN_COMPUTER = onServerScreen ? 'this computer' : 'the server';

/** Each way to connect, in the order offered. 'cli' is the provider itself: the sign-in its own app already has. */
const KINDS: readonly ProviderAuth[] = ['cli', 'signIn', 'apiKey'];
const KIND_LABEL: Record<ProviderAuth, string> = {
  cli: onServerScreen ? 'This computer' : 'The server',
  signIn: 'Sign in',
  apiKey: 'API key',
};
/** What each kind is, and what is left to do in its section once it is added. */
const KIND_HINT: Record<ProviderAuth, string> = {
  cli: `Uses the sign-in the provider’s own app already has on ${OWN_COMPUTER}.`,
  signIn: 'Uses your plan through the provider’s own sign-in. After adding, press Sign in in the account’s section.',
  apiKey: 'Pays per use with a key. After adding, paste it in the account’s section.',
};

const [adding, setAdding] = createSignal(false);

/** The kinds a provider offers: itself until it is added, then only further accounts. */
const kindsOf = (d: DeclaredProvider): ProviderAuth[] =>
  KINDS.filter((kind) => (kind === 'cli' ? !providerAdded(d.id) : kind === 'signIn' ? !!d.accounts?.signIn : !!d.accounts && !!d.apiKey));
/** A sign-in is started in a browser on the server's own screen. */
const addableHere = (kind: ProviderAuth): boolean => kind !== 'signIn' || onServerScreen;
const firstAddable = (d: DeclaredProvider): ProviderAuth | undefined => kindsOf(d).find(addableHere);

/** Providers with something left to add. */
const addableProviders = (): DeclaredProvider[] => offeredProviders().filter((d) => kindsOf(d).length > 0);
export const canAddAccount = (): boolean => addableProviders().length > 0;
export const openAddAccount = (): void => void setAdding(true);

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
  const first = addableProviders()[0]!;
  const [provider, setProvider] = createSignal(first.id);
  const [auth, setAuth] = createSignal<ProviderAuth | undefined>(firstAddable(first));
  const [name, setName] = createSignal(nextAccountName(first));
  const declaration = () => addableProviders().find((p) => p.id === provider());
  const kinds = (): ProviderAuth[] => {
    const d = declaration();
    return d ? kindsOf(d) : [];
  };
  /** An account is named; the provider itself keeps its own name. */
  const named = (): boolean => auth() !== undefined && auth() !== 'cli';
  const action = createAction();
  const choose = (id: string): void => {
    const d = addableProviders().find((p) => p.id === id);
    if (!d) return;
    setProvider(id);
    setAuth(firstAddable(d));
    setName(nextAccountName(d));
  };
  const submit = (): void =>
    void action.run(async () => {
      const kind = auth();
      if (!kind) return;
      if (kind === 'cli') await addProvider(provider());
      else await addProviderAccount(provider(), kind, name());
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
        <p class={styles.lede}>Each provider or account you add gets its own section here, with its own model and usage.</p>
        <label class="cp-field">
          <span class="cp-label">Provider</span>
          <Select value={provider()} options={addableProviders().map((p) => ({ value: p.id, label: p.label }))} onChange={choose} />
        </label>
        {/* A provider with one way to connect has nothing to pick. */}
        <Show when={declaration()?.accounts}>
          <div class="cp-field">
            <span class="cp-label">Connect with</span>
            <SegGroup role="radiogroup" ariaLabel="Connect with" class={styles.kinds} value={auth()} onChange={(v: ProviderAuth) => setAuth(v)}>
              <Show when={kinds().includes('cli')}>
                <SegButton value="cli" label={KIND_LABEL.cli} size="md" />
              </Show>
              <Show when={kinds().includes('signIn')}>
                <SegButton value="signIn" label={KIND_LABEL.signIn} size="md" disabled={!addableHere('signIn')} />
              </Show>
              <Show when={kinds().includes('apiKey')}>
                <SegButton value="apiKey" label={KIND_LABEL.apiKey} size="md" />
              </Show>
            </SegGroup>
            <Show when={auth()}>{(kind) => <span class={styles.hint}>{KIND_HINT[kind()]}</span>}</Show>
            <Show when={kinds().includes('signIn') && !addableHere('signIn')}>
              <span class={styles.hint}>{SIGN_IN_ELSEWHERE}</span>
            </Show>
          </div>
        </Show>
        <Show when={named()}>
          <label class="cp-field">
            <span class="cp-label">Name</span>
            <input type="text" required autofocus maxlength={PROVIDER_DISPLAY_NAME_MAX} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <span class={styles.hint}>Names its section and its line in Plan usage.</span>
          </label>
        </Show>
        <ErrorNote error={action.error()} />
        <div class="cp-actions">
          <SettingsButton onClick={close}>Cancel</SettingsButton>
          <button class="cp-primary" type="submit" disabled={action.busy() || !auth() || (named() && !name().trim())}>
            {action.busy() ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
