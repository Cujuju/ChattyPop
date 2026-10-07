import { For, Show, createSignal } from 'solid-js';
import { REPO_PATTERN } from '@shared/installedPlugins';
import { countText } from '@/ui/format';
import { inCompanion } from '@/state/ui';
import {
  actionBusy, actionError, actionKey, addMarketplace, anyBusy, changeStatus, installLocalPlugin, installedEntry, marketplaceLoadError,
  marketplaceState, pendingChanges, pendingText, restartApp, unlistedInstalled, versionsText,
} from '@/state/marketplace';
import { Card, ErrorNote, FormField, InlineForm, Note, Row, settingsControl as c } from './SettingsLayout';
import { ChangeButtons, MarketplaceCard, PluginName } from './MarketplaceCard';
import styles from './Settings.module.css';

/** Above every Plugins section while changes are staged: what the next start changes, and the restart that applies them. */
export function RestartNotice() {
  const count = () => pendingChanges().length;
  return (
    <Show when={count()}>
      <section class={styles.notice} aria-label="Pending plugin changes">
        <div class={styles.noticeText}>
          <h3 class={styles.noticeTitle}>Restart to apply {countText(count(), 'change')}</h3>
          <Note>{pendingChanges().map(pendingText).join(' · ')}.</Note>
        </div>
        <button type="button" class="cp-primary" disabled={anyBusy()} onClick={() => void restartApp()}>
          {actionBusy(actionKey.restart) ? 'Restarting…' : 'Restart ChattyPop'}
        </button>
        <ErrorNote error={actionError(actionKey.restart)} />
      </section>
    </Show>
  );
}

/** Settings → Plugins → Marketplaces: adding a GitHub repo as a marketplace, then each added one. */
export function MarketplacesBody() {
  const repos = () => marketplaceState()?.marketplaces.map((m) => m.repo) ?? [];
  const listing = (repo: string) => () => marketplaceState()?.marketplaces.find((m) => m.repo === repo);
  return (
    <>
      <AddCard />
      <For each={repos()}>{(repo) => <MarketplaceCard repo={repo} listing={listing(repo)} />}</For>
    </>
  );
}

/** Adds a GitHub repo as a marketplace, with a token for a private one. */
function AddCard() {
  const [repo, setRepo] = createSignal('');
  const [token, setToken] = createSignal('');
  const busy = () => actionBusy(actionKey.add);
  const valid = () => REPO_PATTERN.test(repo().trim());
  const submit = async (): Promise<void> => {
    if (!(await addMarketplace(repo().trim(), token().trim() || null))) return;
    setRepo('');
    setToken('');
  };
  return (
    <Card title="Add a marketplace">
      <InlineForm
        onSubmit={() => void submit()}
        fields={
          <>
            <FormField id="marketplace-repo" label="GitHub repository">
              <input id="marketplace-repo" placeholder="owner/name" autocomplete="off" spellcheck={false} value={repo()} onInput={(e) => setRepo(e.currentTarget.value)} />
            </FormField>
            <FormField id="marketplace-token" label="Access token (optional)">
              <input id="marketplace-token" type="password" autocomplete="off" placeholder="github_pat_…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
            </FormField>
          </>
        }
        button={
          <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !valid()}>
            {busy() ? 'Reading its index…' : 'Add'}
          </button>
        }
      >
        <Show when={repo().trim() && !valid()} fallback={<Note>A repo with a marketplace.json on its default branch. A private one also needs a fine-grained, read-only token for it, stored encrypted on this PC and sent only to GitHub.</Note>}>
          <Note kind="error">Write the repository as owner/name.</Note>
        </Show>
        <ErrorNote error={marketplaceLoadError()} />
        <ErrorNote error={actionError(actionKey.add)} />
      </InlineForm>
    </Card>
  );
}

/** Settings → Plugins → Development: installing a local build, and installed plugins no added marketplace lists. */
export function DevelopmentBody() {
  const [path, setPath] = createSignal('');
  const busy = () => actionBusy(actionKey.local);
  const unlistedIds = () => unlistedInstalled().map((e) => e.id);
  return (
    <>
      <Card title="Install a local build">
        <InlineForm
          onSubmit={() => void installLocalPlugin(path().trim()).then((ok) => ok && setPath(''))}
          fields={
            <FormField id="marketplace-local-path" label="Built plugin folder or .tar.gz">
              <input id="marketplace-local-path" placeholder="C:\path\to\plugin" autocomplete="off" spellcheck={false} value={path()} onInput={(e) => setPath(e.currentTarget.value)} />
            </FormField>
          }
          button={
            <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !path().trim()}>
              {busy() ? 'Installing…' : 'Install'}
            </button>
          }
        >
          <Note>For testing a plugin you build. It installs at the next start.</Note>
          <Show when={inCompanion}>
            <Note>Use a plugin folder or .tar.gz on your PC.</Note>
          </Show>
          <ErrorNote error={actionError(actionKey.local)} />
        </InlineForm>
      </Card>
      <Show when={unlistedIds().length}>
        <Card title="Outside marketplaces" meta={countText(unlistedIds().length, 'plugin')}>
          <For each={unlistedIds()}>
            {(id) => (
              <Row
                label={<PluginName name={installedEntry(id)?.name ?? id} status={changeStatus(installedEntry(id))} />}
                hint={versionsText(installedEntry(id)) ?? undefined}
              >
                <div class={c.buttons}>
                  <ChangeButtons entry={installedEntry(id)} busy={actionBusy(actionKey.plugin(id))} />
                </div>
                <ErrorNote error={actionError(actionKey.plugin(id))} />
              </Row>
            )}
          </For>
        </Card>
      </Show>
    </>
  );
}
