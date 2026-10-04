import { For, Show, createSignal } from 'solid-js';
import type { FootprintKind, RestoreItem } from '@shared/pluginRestore';
import { countText } from '@/ui/format';
import { actionBusy, actionError, actionKey, addMarketplace, anyBusy, setMarketplaceToken } from '@/state/marketplace';
import { dismissRestore, installAllRestore, installRestore, restoreChecking, restoreLoadError, restoreOffers } from '@/state/pluginRestore';
import { Card, ErrorNote, FormField, InlineForm, Note, Row, SettingsButton, settingsControl as c } from './SettingsLayout';
import styles from './Settings.module.css';

/** Each footprint kind as the notice names it. */
const KIND_TEXT: Record<FootprintKind, string> = { table: 'tables', preference: 'preferences', dataDir: 'data folder', rule: 'rules', state: 'on/off setting' };

/** Above every Plugins section while plugins whose data remains aren't installed: each one's install, and Install all. */
export function RestoreNotice() {
  const ids = () => restoreOffers().map((item) => item.id);
  const item = (id: string) => () => restoreOffers().find((i) => i.id === id);
  const installable = () => restoreOffers().filter((i) => i.install).length;
  return (
    <Show when={ids().length}>
      <section class={styles.notice} aria-label="Plugins to restore">
        <div class={styles.noticeText}>
          <h3 class={styles.noticeTitle}>
            {countText(ids().length, 'plugin')} you used {ids().length === 1 ? "isn't" : "aren't"} installed
          </h3>
          <Note>
            {restoreChecking() ? 'Checking your marketplaces…' : `Their data is still here: ${restoreOffers().map((i) => i.name).join(', ')}.`}
          </Note>
        </div>
        <Show when={installable() > 1}>
          <button type="button" class="cp-primary" disabled={anyBusy()} onClick={() => void installAllRestore()}>
            Install all
          </button>
        </Show>
        <div class={styles.noticeBody}>
          <Card>
            <For each={ids()}>{(id) => <RestoreRow item={item(id)} />}</For>
          </Card>
          <For each={neededRepos()}>{(repo) => <NeededMarketplace repo={repo} />}</For>
        </div>
        <ErrorNote error={restoreLoadError()} />
      </section>
    </Show>
  );
}

/** Each marketplace some offer needs, once, in the order the offers name them. */
const neededRepos = (): string[] => [...new Set(restoreOffers().flatMap((i) => (i.needs ? [i.needs.repo] : [])))];

/** Adds marketplace `repo` (or saves its token when it's added but unreadable); its listing then matches the offers. */
function NeededMarketplace(props: { repo: string }) {
  const [token, setToken] = createSignal('');
  const offers = () => restoreOffers().filter((i) => i.needs?.repo === props.repo);
  const added = () => offers().some((i) => i.needs?.added);
  const key = () => (added() ? actionKey.marketplace(props.repo) : actionKey.add);
  const id = () => `restore-token-${props.repo.replace('/', '-')}`;
  const submit = async (): Promise<void> => {
    const value = token().trim() || null;
    if (await (added() ? setMarketplaceToken(props.repo, value) : addMarketplace(props.repo, value))) setToken('');
  };
  return (
    <Card title={`${offers().map((i) => i.name).join(', ')} ${offers().length === 1 ? 'is' : 'are'} in ${props.repo}`}>
      <InlineForm
        onSubmit={() => void submit()}
        fields={
          <FormField id={id()} label="Access token (for a private repo)">
            <input id={id()} type="password" autocomplete="off" placeholder="github_pat_…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
          </FormField>
        }
        button={
          <button type="submit" class={`cp-button ${styles.button}`} disabled={actionBusy(key())}>
            {actionBusy(key()) ? 'Reading its index…' : added() ? 'Save token' : 'Add marketplace'}
          </button>
        }
      >
        <Note>A fine-grained, read-only token for it, stored encrypted on this PC and sent only to GitHub.</Note>
        <ErrorNote error={actionError(key())} />
      </InlineForm>
    </Card>
  );
}

/** What installing it takes, or why it can't, and the data it left. */
function restoreText(item: RestoreItem): string {
  const install = item.install;
  const how = install ? `${install.version ? `Release ${install.version}` : 'Source'} from ${install.repo}` : item.problem;
  return `${how} · Kept: ${item.kinds.map((k) => KIND_TEXT[k]).join(', ')}`;
}

function RestoreRow(props: { item: () => RestoreItem | undefined }) {
  return (
    <Show when={props.item()}>
      {(item) => (
        <Row
          label={item().name}
          hint={restoreText(item())}
          control={
            <div class={c.buttons} data-plugin={item().id}>
              <Show when={item().install}>
                <SettingsButton disabled={actionBusy(actionKey.plugin(item().id))} onClick={() => void installRestore(item())}>
                  {actionBusy(actionKey.plugin(item().id)) ? 'Installing…' : 'Install'}
                </SettingsButton>
              </Show>
              <SettingsButton title="Stops offering it; its marketplace still lists it" onClick={() => dismissRestore(item().id)}>
                Dismiss
              </SettingsButton>
            </div>
          }
        >
          <ErrorNote error={actionError(actionKey.plugin(item().id))} />
        </Row>
      )}
    </Show>
  );
}
