// Settings → AI: a section per running provider (docs/plugin-architecture.md §3, AI providers), then plugins' sections.
import { aiText } from '@/plugins/presentation';
import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { HostProviderRowId } from '@shared/anchors';
import type { DeclaredProvider } from '@shared/aiProviders';
import type { ProviderId } from '@shared/settings';
import { providerRows, providerView, settingsSections } from '@/plugins/slots';
import type { ProviderRow } from '@/plugins/frameSlots';
import { availableProviders, providerReportsPlanUsage } from '@/state/aiProviders';
import { providerLabel, providerSettingsOf, providerStatusFailure, providerStatusLoading, refreshProviderStatus, updateProvider } from '@/state/preferences';
import { Switch } from '@/ui/Switch';
import { effortLabel, keptEffort } from './EffortSelect';
import { ModelList } from './ModelList';
import { EffortRow, modelOption, statusOf } from './ModelRows';
import { OpenRouterKeys } from './OpenRouterKeys';
import { AccountRow, EarlierKeyRow, RemoveProviderButton } from './AccountRows';
import { AddAccountDialog, canAddAccount, openAddAccount } from './AddAccount';
import { Card, Note, Page, Row, SectionsPage, settingsControl as c } from './SettingsLayout';
import { PlanUsage } from './PlanUsage';
import styles from './Settings.module.css';

/** A provider's state in a few words: on or off, the model it uses and its effort. */
function providerMeta(d: DeclaredProvider): string {
  const p = providerSettingsOf(d.id);
  if (!p.enabled) return statusOf(d.id)?.available === false ? 'Off · not available' : 'Off';
  const model = p.model ? (modelOption(d.id, p.model)?.label ?? p.model) : 'provider default';
  return `On · ${model}${p.effort ? ` · ${effortLabel(p.effort)}` : ''}`;
}

/** A provider's site as its section's title links it, named by its host; none unless an http(s) URL. */
function siteLink(site: string | undefined): { href: string; label: string } | undefined {
  if (!site) return undefined;
  try {
    const url = new URL(site);
    return /^https?:$/.test(url.protocol) ? { href: url.href, label: url.host.replace(/^www\./, '') } : undefined;
  } catch {
    return undefined;
  }
}

/** Settings → AI: each running provider on its own section: on/off, default, model, plan usage, and its own settings. */
export function AiSection() {
  const sections = () => [
    ...availableProviders().map((d) => ({
      id: d.id,
      label: d.label,
      meta: () => providerMeta(d),
      muted: () => !providerSettingsOf(d.id).enabled,
      link: siteLink(d.site),
      actions: () => <RemoveProviderButton provider={d.id} />,
      body: () => <ProviderBody provider={d} />,
    })),
    ...settingsSections('ai'),
  ];
  /** Nothing is listed: the owner adds each provider, or no provider plugin is on to add from. */
  const empty = () => (
    <Page id="ai" title="AI providers" lede={aiText().overview}>
      <Show when={canAddAccount()} fallback={<Note>No AI provider plugin is on. Turn one on in Settings → Plugins.</Note>}>
        <Note>No AI provider yet. Add each one you want ChattyPop to use.</Note>
        <div class={c.buttons}>
          <button type="button" class="cp-primary" onClick={openAddAccount}>
            Add account
          </button>
        </div>
      </Show>
    </Page>
  );
  const refresh = (
    <button type="button" class={`cp-button ${styles.button}`} disabled={providerStatusLoading()} onClick={() => void refreshProviderStatus()}>
      {providerStatusLoading() ? 'Loading models…' : 'Refresh model lists'}
    </button>
  );
  return (
    <>
      <Show when={sections().length > 0} fallback={empty()}>
        <SectionsPage
          id="ai"
          title="AI providers"
          lede={aiText().overview}
          right={refresh}
          railAdd={canAddAccount() ? { label: 'Add account', onClick: openAddAccount } : undefined}
          sections={sections()}
        />
      </Show>
      <AddAccountDialog />
    </>
  );
}

/** A provider's switch, which turns it off and keeps it listed with its sign-in, key and choices; its availability line and its plugin's note. */
function EnabledRow(props: { provider: ProviderId }) {
  const id = props.provider;
  const enabled = () => providerSettingsOf(id).enabled;
  const hint = (): string => {
    const status = statusOf(id);
    if (status) return status.detail + (providerView(id)?.note?.(status) ?? '');
    const failed = providerStatusFailure();
    return failed ? `Couldn't check: ${failed}` : 'Checking…';
  };
  return (
    <Row
      label={`Use ${providerLabel(id)}`}
      for={`ai-enabled-${id}`}
      hint={hint()}
      control={<Switch id={`ai-enabled-${id}`} checked={enabled()} disabled={!statusOf(id)?.available && !enabled()} onChange={(on) => updateProvider(id, { enabled: on })} />}
    />
  );
}

/** The host's rows of a provider's card, in HOST_PROVIDER_ROWS order; plugins place theirs among them. */
const HOST_ROWS: readonly (ProviderRow & { id: HostProviderRowId })[] = [
  { id: 'enabled', Component: EnabledRow },
  { id: 'account', Component: AccountRow },
  { id: 'api-key', Component: EarlierKeyRow },
  { id: 'model', Component: (p) => <ProviderModels provider={p.provider} /> },
  { id: 'effort', Component: (p) => <EffortRow fieldId={`ai-effort-${p.provider}`} provider={p.provider} value={providerSettingsOf(p.provider)} onChange={(v) => updateProvider(p.provider, v)} /> },
  { id: 'plan-usage', Component: (p) => <Show when={providerReportsPlanUsage(p.provider) && statusOf(p.provider)?.available}><PlanUsage id={p.provider} /></Show> },
  { id: 'rows', Component: (p) => <Show when={providerView(p.provider)?.rows}>{(Rows) => <Dynamic component={Rows()} />}</Show> },
];

/** The model the provider's requests use, picked from its list; its plugin's action (Delete) on each when managed. */
function ProviderModels(props: { provider: ProviderId }) {
  const id = props.provider;
  const choice = () => providerSettingsOf(id);
  const action = () => providerView(id)?.modelAction;
  return (
    <Show when={statusOf(id)?.models} fallback={<Row label="Model" hint={statusOf(id) ? 'None listed: see above.' : 'Loading models…'} />}>
      {(models) => (
        <ModelList
          id={`ai-model-${id}`}
          models={models()}
          value={choice().model}
          action={action() ? (m) => <Dynamic component={action()!} model={m} /> : undefined}
          onChange={(model) => updateProvider(id, { model, effort: keptEffort(choice().effort, modelOption(id, model)) })}
        />
      )}
    </Show>
  );
}

function ProviderBody(props: { provider: DeclaredProvider }) {
  const d = () => props.provider;
  return (
    <>
      <Card>
        <For each={providerRows(HOST_ROWS)}>{(row) => <row.Component provider={d().id} />}</For>
      </Card>
      <Show when={d().openRouterKeys}>
        <OpenRouterKeys models={statusOf(d().id)?.models ?? null} />
      </Show>
    </>
  );
}
