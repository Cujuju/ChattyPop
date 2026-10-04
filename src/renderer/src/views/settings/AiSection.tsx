// Settings → AI: a section per running provider (docs/plugin-architecture.md §3, AI providers), then plugins' sections.
import { api } from '@/api';
import { aiText } from '@/plugins/presentation';
import { For, Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { HostProviderRowId } from '@shared/anchors';
import { declaredProvider, providerLabel, type DeclaredProvider } from '@shared/aiProviders';
import type { PlanUsageWindow } from '@shared/contract';
import type { ProviderId } from '@shared/settings';
import { providerRows, providerView, settingsSections } from '@/plugins/slots';
import type { ProviderRow } from '@/plugins/frameSlots';
import { availableProviders } from '@/state/aiProviders';
import { providerSettingsOf, providerStatusFailure, providerStatusLoading, refreshProviderStatus, updateProvider } from '@/state/preferences';
import { createAction } from '@/ui/action';
import { Switch } from '@/ui/Switch';
import { effortLabel, keptEffort } from './EffortSelect';
import { ModelList } from './ModelList';
import { EffortRow, modelOption, statusOf } from './ModelRows';
import { OpenRouterKeys } from './OpenRouterKeys';
import { Card, ErrorNote, Note, Page, Row, SectionsPage, settingsControl as c } from './SettingsLayout';
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
      body: () => <ProviderBody provider={d} />,
    })),
    ...settingsSections('ai'),
  ];
  const refresh = (
    <button type="button" class={`cp-button ${styles.button}`} disabled={providerStatusLoading()} onClick={() => void refreshProviderStatus()}>
      {providerStatusLoading() ? 'Loading models…' : 'Refresh model lists'}
    </button>
  );
  return (
    <Show
      when={sections().length > 0}
      fallback={
        <Page id="ai" title="AI providers" lede={aiText().overview}>
          <Note>No AI provider plugin is on. Turn one on in Settings → Plugins.</Note>
        </Page>
      }
    >
      <SectionsPage id="ai" title="AI providers" lede={aiText().overview} right={refresh} sections={sections()} />
    </Show>
  );
}

/** A provider's switch, its availability line and the note its plugin adds. */
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
  { id: 'model', Component: (p) => <ProviderModels provider={p.provider} /> },
  { id: 'effort', Component: (p) => <EffortRow fieldId={`ai-effort-${p.provider}`} provider={p.provider} value={providerSettingsOf(p.provider)} onChange={(v) => updateProvider(p.provider, v)} /> },
  { id: 'plan-usage', Component: (p) => <Show when={declaredProvider(p.provider)?.planUsage && statusOf(p.provider)?.available}><PlanUsage id={p.provider} /></Show> },
  { id: 'rows', Component: (p) => <Show when={providerView(p.provider)?.rows}>{(Rows) => <Dynamic component={Rows()} />}</Show> },
];

/** The provider's models, one picked for its requests; its plugin's action (Delete) beside each. */
function ProviderModels(props: { provider: ProviderId }) {
  const id = props.provider;
  const choice = () => providerSettingsOf(id);
  const action = () => providerView(id)?.modelAction;
  return (
    <>
      <Row label="Models" hint={statusOf(id)?.models ? 'What each can do. Requests use the one picked.' : statusOf(id) ? 'None listed: see above.' : 'Loading models…'} />
      <Show when={statusOf(id)?.models}>
        {(models) => (
          <ModelList
            name={`ai-model-${id}`}
            models={models()}
            value={choice().model}
            action={action() ? (m) => <Dynamic component={action()!} model={m} /> : undefined}
            onChange={(model) => updateProvider(id, { model, effort: keptEffort(choice().effort, modelOption(id, model)) })}
          />
        )}
      </Show>
    </>
  );
}

function ProviderBody(props: { provider: DeclaredProvider }) {
  const d = props.provider;
  return (
    <>
      <Card>
        <For each={providerRows(HOST_ROWS)}>{(row) => <row.Component provider={d.id} />}</For>
      </Card>
      <Show when={d.openRouterKeys}>
        <OpenRouterKeys models={statusOf(d.id)?.models ?? null} />
      </Show>
    </>
  );
}

function PlanUsage(props: { id: ProviderId }) {
  const [windows, setWindows] = createSignal<PlanUsageWindow[] | null | undefined>(undefined);
  const action = createAction();
  const check = async (): Promise<void> => {
    const w = await action.run(() => api.core.aiPlanUsage(props.id));
    if (w !== undefined) setWindows(w);
  };
  return (
    <Row
      label="Plan usage"
      hint="How much of your plan's limits you've used, as the provider reports it."
      control={
        <button type="button" class={`cp-button ${styles.button}`} onClick={() => void check()}>
          Check plan usage
        </button>
      }
    >
      <ErrorNote error={action.error()} />
      <Show when={windows() === null}>
        <Note>No plan limits reported.</Note>
      </Show>
      <Show when={windows()?.length}>
        <div class={c.buttons}>
          <For each={windows() ?? []}>
            {(w) => (
              <span class={styles.usageWindow}>
                {w.label}: {w.usedPercent === null ? '?' : Math.round(w.usedPercent)}%{w.note ? ` (${w.note})` : ''}
              </span>
            )}
          </For>
        </div>
      </Show>
    </Row>
  );
}
