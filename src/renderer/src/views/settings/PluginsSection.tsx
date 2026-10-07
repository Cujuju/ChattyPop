import { For, Show, createSignal, onMount } from 'solid-js';
import type { PluginInfo } from '@shared/plugins';
import { countText, errorText } from '@/ui/format';
import { openPluginsFolder, plugins, reloadPlugins, runPluginCommand, setPluginEnabled } from '@/state/plugins';
import { inCompanion } from '@/state/ui';
import { loadMarketplaces, marketplaceState, pendingChanges, unlistedInstalled } from '@/state/marketplace';
import { Switch } from '@/ui/Switch';
import { Card, ErrorNote, Note, Row, SectionsPage, settingsControl as c } from './SettingsLayout';
import { DevelopmentBody, MarketplacesBody, RestartNotice } from './MarketplacesSection';
import { loadRestore } from '@/state/pluginRestore';
import { RestoreNotice } from './RestoreNotice';
import styles from './Settings.module.css';

const STATUS_LABEL: Record<PluginInfo['status'], string> = { active: 'active', disabled: 'off', error: 'failed to load' };
/** Where a plugin comes from; a folder plugin needs no note. */
const ORIGIN_LABEL: Record<PluginInfo['origin'], string | null> = { bundled: 'development', installed: 'installed', folder: null };

/** "1 pending" after a section's meta when its plugins have staged changes. */
const withPending = (meta: string, pending: number): string => (pending ? `${meta} · ${pending} pending` : meta);

/** Installed plugins' one-line state: how many, and how many are off or failed. */
function installedMeta(): string {
  const count = (status: PluginInfo['status']): number => plugins().filter((p) => p.status === status).length;
  const off = count('disabled');
  const failed = count('error');
  return [countText(plugins().length, 'plugin'), off ? `${off} off` : null, failed ? `${failed} failed` : null].filter(Boolean).join(' · ');
}

function marketplacesMeta(): string {
  const added = marketplaceState()?.marketplaces.length ?? 0;
  const unlisted = new Set(unlistedInstalled().map((e) => e.id));
  return withPending(added ? countText(added, 'marketplace') : 'none added', pendingChanges().filter((e) => !unlisted.has(e.id)).length);
}

function developmentMeta(): string {
  const unlisted = unlistedInstalled();
  return withPending(unlisted.length ? `${unlisted.length} not in a marketplace` : 'local builds', unlisted.filter((e) => e.pending).length);
}

/** Settings → Plugins: installed plugins with on/off, errors and commands; marketplaces; local builds. */
export function PluginsSection() {
  // The rail's metas and the restart and restore notices read it on every section.
  onMount(() => void loadMarketplaces().then(loadRestore));
  return (
    <SectionsPage
      id="plugins"
      title="Plugins"
      lede="Plugins install from a marketplace or load from the plugins folder; a development run also compiles in local clones. Every plugin runs with full access to the archive and your AI providers, so only add ones you trust."
      right={
        <>
          <Show when={!inCompanion}>
            <button type="button" class={`cp-button ${styles.button}`} onClick={() => void openPluginsFolder()}>
              Open plugins folder
            </button>
          </Show>
          <button type="button" class={`cp-button ${styles.button}`} onClick={() => void reloadPlugins()}>
            Reload plugins
          </button>
        </>
      }
      notice={
        <>
          <Show when={inCompanion}>
            <Note>Open the plugins folder on your PC.</Note>
          </Show>
          <RestoreNotice />
          <RestartNotice />
        </>
      }
      sections={[
        { id: 'installed', label: 'Installed', meta: installedMeta, body: InstalledBody },
        { id: 'marketplaces', label: 'Marketplaces', meta: marketplacesMeta, body: MarketplacesBody },
        { id: 'development', label: 'Development', meta: developmentMeta, body: DevelopmentBody },
      ]}
    />
  );
}

function InstalledBody() {
  return (
    <Card>
      <For each={plugins()} fallback={<Row label="No plugins installed." hint="Put a plugin's folder in the plugins folder, then reload." />}>
        {(p) => <PluginRow plugin={p} />}
      </For>
    </Card>
  );
}

function PluginRow(props: { plugin: PluginInfo }) {
  const p = () => props.plugin;
  const [result, setResult] = createSignal<string | null>(null);
  const run = (commandId: string): void => {
    setResult('Running…');
    runPluginCommand(p().id, commandId).then(setResult, (err: unknown) => setResult(errorText(err)));
  };
  return (
    <Row
      label={`${p().name} ${p().version}`}
      for={`plugin-${p().key ?? p().id}`}
      hint={[p().description, ORIGIN_LABEL[p().origin], STATUS_LABEL[p().status]].filter(Boolean).join(' · ')}
      control={<Switch id={`plugin-${p().key ?? p().id}`} checked={p().status !== 'disabled'} disabled={p().version === '?' || p().conflict} onChange={(on) => void setPluginEnabled(p().key ?? p().id, on)} />}
    >
      <ErrorNote error={p().error} />
      <Show when={p().commands.length}>
        <div class={c.buttons}>
          <For each={p().commands}>
            {(cmd) => (
              <button type="button" class={`cp-button ${styles.button}`} title="Runs on the last 24 hours of every archived channel" onClick={() => run(cmd.id)}>
                {cmd.title}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={result()}>{(r) => <Note kind="status">{r()}</Note>}</Show>
    </Row>
  );
}
