import { For, Show, createMemo, createSignal } from 'solid-js';
import type { InstalledEntry, MarketplaceListing } from '@shared/marketplace';
import { countText, shortDateTime } from '@/ui/format';
import {
  actionBusy, actionError, actionKey, cancelPending, cancelText, changeStatus, installPlugin, installedEntry, refreshMarketplaces, releaseOffer,
  removable, removeMarketplace, setMarketplaceToken, uninstallPlugin, versionsText, type ChangeStatus,
} from '@/state/marketplace';
import { look } from '@/theme/look';
import { Card, ErrorNote, FormField, InlineForm, Note, Row, SettingsButton, settingsControl as c } from './SettingsLayout';
import styles from './Settings.module.css';

/**
 * One marketplace: its plugins, then its index, token and removal (a built-in one has neither). Reads its listing by
 * repo so reloads keep local state.
 */
export function MarketplaceCard(props: { listing: () => MarketplaceListing | undefined; repo: string }) {
  const key = () => actionKey.marketplace(props.repo);
  const busy = () => actionBusy(key());
  const [confirmingRemove, setConfirmingRemove] = createSignal(false);
  const [editingToken, setEditingToken] = createSignal(false);
  const [token, setToken] = createSignal('');
  const pluginIds = () => props.listing()?.plugins.map((p) => p.id) ?? [];
  const builtIn = () => props.listing()?.builtIn ?? false;
  const meta = () => (builtIn() ? `Built in · ${countText(pluginIds().length, 'plugin')}` : countText(pluginIds().length, 'plugin'));
  const saveToken = async (value: string | null): Promise<void> => {
    if (!(await setMarketplaceToken(props.repo, value))) return;
    setToken('');
    setEditingToken(false);
  };
  const statusText = (): string => {
    const at = props.listing()?.fetchedAt;
    const read = at ? `Index read ${shortDateTime(at)}.` : 'Index not read yet.';
    if (builtIn()) return `${read} Built in: public, so it needs no token, and always listed.`;
    return `${read} ${props.listing()?.hasToken ? 'Token stored encrypted on this PC; sent only to GitHub.' : 'No token; a private repo needs one.'}`;
  };
  return (
    <Card title={props.repo} meta={meta()}>
      <div class={c.group} data-repo={props.repo} data-state={props.listing()?.error ? 'error' : 'ok'}>
        <ErrorNote error={props.listing()?.error} />
        <For each={pluginIds()} fallback={<Show when={!props.listing()?.error}><Row label="No plugins listed." hint="Its marketplace.json lists none." /></Show>}>
          {(id) => <PluginRow repo={props.repo} listing={props.listing} id={id} />}
        </For>
        <Row
          label={builtIn() ? 'Index' : 'Index and token'}
          hint={statusText()}
          control={
            <>
              <SettingsButton disabled={actionBusy(actionKey.refresh)} onClick={() => void refreshMarketplaces()}>
                {actionBusy(actionKey.refresh) ? 'Refreshing…' : 'Refresh'}
              </SettingsButton>
              <Show when={!builtIn()}>
                <SettingsButton disabled={busy()} aria-expanded={editingToken()} onClick={() => setEditingToken((on) => !on)}>
                  {props.listing()?.hasToken ? 'Change token' : 'Set token'}
                </SettingsButton>
                <SettingsButton disabled={busy() || confirmingRemove()} onClick={() => setConfirmingRemove(true)}>
                  Remove
                </SettingsButton>
              </Show>
            </>
          }
        >
          <ErrorNote error={actionError(actionKey.refresh)} />
          <Show when={editingToken()}>
            <InlineForm
              onSubmit={() => void saveToken(token().trim())}
              fields={
                <FormField id={`marketplace-token-${props.repo}`} label={props.listing()?.hasToken ? 'New access token' : 'Access token'}>
                  <input id={`marketplace-token-${props.repo}`} type="password" autocomplete="off" placeholder="github_pat_…" value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
                </FormField>
              }
              button={
                <>
                  <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !token().trim()}>
                    Save token
                  </button>
                  <Show when={props.listing()?.hasToken}>
                    <SettingsButton disabled={busy()} onClick={() => void saveToken(null)}>
                      Clear token
                    </SettingsButton>
                  </Show>
                </>
              }
            />
          </Show>
          <Show when={confirmingRemove()}>
            <div class={`cp-condition ${look.card}`} role="group" aria-label={`Confirm removing ${props.repo}`}>
              <Note>Remove {props.repo}? It forgets the marketplace and its token; plugins installed from it stay.</Note>
              <div class={c.buttons}>
                <button type="button" class="cp-danger" disabled={busy()} onClick={() => void removeMarketplace(props.repo)}>
                  {busy() ? 'Removing…' : 'Remove marketplace'}
                </button>
                <SettingsButton disabled={busy()} onClick={() => setConfirmingRemove(false)}>
                  Keep it
                </SettingsButton>
              </div>
            </div>
          </Show>
          <ErrorNote error={actionError(key())} />
        </Row>
      </div>
    </Card>
  );
}

/** One listed plugin: what it offers, what's installed, and its actions. */
function PluginRow(props: { repo: string; listing: () => MarketplaceListing | undefined; id: string }) {
  const plugin = () => props.listing()?.plugins.find((p) => p.id === props.id);
  const entry = () => installedEntry(props.id);
  const offer = createMemo(() => {
    const p = plugin();
    return p ? releaseOffer(props.repo, p, entry()) : null;
  });
  const facts = (): string => {
    const newest = plugin()?.releases[0];
    const versions = versionsText(entry(), props.repo);
    if (!versions) return newest ? `Latest ${newest.version}` : 'No releases';
    return `${versions} · ${newest ? `latest ${newest.version}` : 'no releases'}`;
  };
  return (
    <Show when={plugin()}>
      {(p) => (
        <Row
          label={<PluginName name={p().name} status={changeStatus(entry())} />}
          hint={
            <>
              <Show when={p().description}>
                <span class={styles.hintLine}>{p().description}</span>
              </Show>
              <span class={styles.hintLine}>{facts()}</span>
            </>
          }
        >
          <PluginActions repo={props.repo} id={props.id} entry={entry()} releaseAction={offer()?.action ?? null} releaseVersion={offer()?.release?.version ?? null} sourceBranch={p().source?.branch ?? null} />
          <Show when={offer()?.incompatible}>{(why) => <Note>{offer()?.release ? `Newest release: ${why()}` : `Can't install: ${why()}`}</Note>}</Show>
          <ErrorNote error={actionError(actionKey.plugin(props.id))} />
        </Row>
      )}
    </Show>
  );
}

/** A plugin's name and its status pill (installed, or the change the next start makes). */
export function PluginName(props: { name: string; status: ChangeStatus | null }) {
  return (
    <span class={styles.pluginName}>
      {props.name}
      <Show when={props.status}>
        {(s) => (
          <span class={`${styles.status} ${look.status}`} data-tint={s().tint ?? undefined}>
            {s().label}
          </span>
        )}
      </Show>
    </span>
  );
}

/** Install / update, install from source, and remove or cancel, for one plugin. */
function PluginActions(props: { repo: string; id: string; entry: InstalledEntry | undefined; releaseAction: string | null; releaseVersion: string | null; sourceBranch: string | null }) {
  const busy = () => actionBusy(actionKey.plugin(props.id));
  return (
    <div class={c.buttons} data-plugin={props.id}>
      <Show when={props.releaseAction && props.releaseVersion}>
        {(version) => (
          <SettingsButton disabled={busy()} onClick={() => void installPlugin(props.repo, props.id, { kind: 'release', version: version() })}>
            {props.releaseAction}
          </SettingsButton>
        )}
      </Show>
      <Show when={props.sourceBranch}>
        {(branch) => (
          <SettingsButton disabled={busy()} title={`Builds the latest commit on ${branch()}`} onClick={() => void installPlugin(props.repo, props.id, { kind: 'source' })}>
            Install from source ({branch()})
          </SettingsButton>
        )}
      </Show>
      <ChangeButtons entry={props.entry} busy={busy()} />
    </div>
  );
}

/** Cancel for a pending change, and Uninstall for a running plugin whose removal isn't staged. */
export function ChangeButtons(props: { entry: InstalledEntry | undefined; busy: boolean }) {
  return (
    <Show when={props.entry}>
      {(e) => (
        <>
          <Show when={cancelText(e())}>
            {(text) => (
              <SettingsButton disabled={props.busy} onClick={() => void cancelPending(e().id)}>
                {text()}
              </SettingsButton>
            )}
          </Show>
          <Show when={removable(e())}>
            <SettingsButton disabled={props.busy} onClick={() => void uninstallPlugin(e().id)}>
              Uninstall
            </SettingsButton>
          </Show>
        </>
      )}
    </Show>
  );
}