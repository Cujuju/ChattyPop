import { Show, createSignal } from 'solid-js';
import { api } from '@/api';
import { declaredProvider } from '@shared/aiProviders';
import { accountKey } from '@shared/providerAccounts';
import type { ProviderId } from '@shared/settings';
import { aiSettings, providerLabel, refetchProviderStatus } from '@/state/preferences';
import { accountLink, removeProvider } from '@/state/providerAccounts';
import { failureNotice } from '@/state/dialogs';
import { onServerScreen } from '@/state/ui';
import { createAction } from '@/ui/action';
import { HoldButton } from '@/ui/HoldButton';
import { statusOf } from './ModelRows';
import { StoredKeyRow } from './StoredKeyRow';
import { ErrorNote, Note, Row, SettingsButton, settingsControl as c } from './SettingsLayout';

type Props = { provider: ProviderId };
export function AccountRow(props: Props) {
  const account = () => aiSettings().accounts.find((a) => a.id === props.provider);
  return <Show when={account()}>{(a) => <Show when={a().auth === 'signIn'} fallback={
    <StoredKeyRow label="API key" fieldId={`ai-key-${props.provider}`} placeholder={declaredProvider(props.provider)?.apiKey?.placeholder ?? ''}
      hint={statusOf(props.provider)?.apiKeyHint ?? null} emptyHint="Add the API key that pays for this account."
      onSave={async (key) => { await api.providerKeys.setKey(props.provider, key); await refetchProviderStatus(); }}
      onRemove={async () => { await api.providerKeys.removeKey(props.provider); await refetchProviderStatus(); }}
      removeMessage={`Remove the ${providerLabel(props.provider)} API key from ChattyPop?`} />
  }><SignInRow provider={props.provider} /></Show>}</Show>;
}

function SignInRow(props: Props) {
  const link = () => accountLink(props.provider);
  const waiting = () => link()?.state === 'waiting';
  const [code, setCode] = createSignal('');
  const action = createAction();
  return <Row label="Account" hint={statusOf(props.provider)?.detail} control={
    <Show when={onServerScreen && !waiting() && !statusOf(props.provider)?.signedIn}>
      <SettingsButton disabled={action.busy()} onClick={() => void action.run(() => api.core.linkProviderAccount(props.provider))}>Sign in</SettingsButton>
    </Show>
  }>
    <Show when={!onServerScreen}><Note>Sign in on the server’s own screen.</Note></Show>
    <Show when={waiting()}>
      <Note>Finish signing in in your browser.</Note>
      <Show when={link()?.url}>{(url) => <a href={url()} target="_blank" rel="noreferrer">Open the sign-in page</a>}</Show>
      <form onSubmit={(e) => { e.preventDefault(); void action.run(async () => { await api.core.submitAccountLinkCode(props.provider, code()); setCode(''); }); }}>
        <div class={c.buttons}>
          <input class={c.select} aria-label="Sign-in code" autocomplete="off" value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
          <button class="cp-button" type="submit" disabled={!code().trim() || action.busy()}>Submit code</button>
          <SettingsButton onClick={() => void action.run(() => api.core.cancelAccountLink(props.provider))}>Cancel</SettingsButton>
        </div>
      </form>
    </Show>
    <ErrorNote error={link()?.state === 'failed' ? link()?.error : null} />
    <ErrorNote error={action.error()} />
  </Row>;
}

/** In the section's title: a full hold removes the provider, an account with its sign-in or API key, without a confirmation dialog. */
export function RemoveProviderButton(props: Props) {
  const [busy, setBusy] = createSignal(false);
  const what = (): string => {
    const account = aiSettings().accounts.find((a) => a.id === props.provider);
    return account ? `this account and its ${account.auth === 'signIn' ? 'sign-in' : 'API key'}` : providerLabel(props.provider);
  };
  const remove = (): void => {
    setBusy(true);
    void removeProvider(props.provider).catch(failureNotice(`Couldn't remove ${providerLabel(props.provider)}`)).finally(() => setBusy(false));
  };
  return <HoldButton icon="trash" action={`remove ${what()}`} disabled={busy()} onComplete={remove} />;
}

export function EarlierKeyRow(props: Props) {
  const hint = () => !accountKey(props.provider) ? statusOf(props.provider)?.apiKeyHint : null;
  const action = createAction();
  return <Show when={hint()}><Row label="Earlier API key" hint={`Stored, ending ${hint()}. No longer used: add it as an API key account.`} control={
    <SettingsButton disabled={action.busy()} onClick={() => void action.run(async () => { await api.providerKeys.removeKey(props.provider); await refetchProviderStatus(); })}>Remove key</SettingsButton>
  }><ErrorNote error={action.error()} /></Row></Show>;
}
