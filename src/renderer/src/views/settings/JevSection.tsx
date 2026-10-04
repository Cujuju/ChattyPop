// Jev settings and switches contributed by active bundled plugins.
import { api } from '@/api';
import { Dynamic } from 'solid-js/web';
import { For, Show, createSignal, type JSX } from 'solid-js';
import { JEV_QUERIES, effectiveJevQuery, type JevQueryDef } from '@shared/jevQueries';
import type { JevStatus } from '@shared/contract';
import { managedRuleFeatures, pluginJevFeatures } from '@/plugins/slots';
import { bundledJevFeatures } from '@shared/bundledPlugins';
import { HOST_JEV_FEATURES, jevFeatureOn, type JevConnection, type JevFeature } from '@shared/settings';
import { jevQueryOverrides } from '@/state/jevQueries';
import { jevUseRecent, jevUseToday, usdPerQuestion } from '@/state/jevSpend';
import { jevFeatureLocked, jevStatus, refetchJevStatus, toggleJevFeature } from '@/state/jevStatus';
import { aiSettings, patchAiSettings } from '@/state/preferences';
import { availableProviders } from '@/state/aiProviders';
import { OpenRouterKeys } from './OpenRouterKeys';
import { createAction } from '@/ui/action';
import { percentText, usdText } from '@/ui/format';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { orderJevFeatures } from '@/plugins/featureWording';
import { JEV_FEATURE_INFO, jevFeatureLabel, type JevFeatureInfo } from './jevFeatures';
import { JevQueriesSection, JevViewSwitch, jevView, showJevQuery } from './JevQueriesSection';
import { Card, ErrorNote, Note, Row, SectionsPage, Stat, Stats, settingsControl as c } from './SettingsLayout';
import styles from './Settings.module.css';

/** Example volume for the monthly cost line, and a month in days. */
const PER_DAY_EXAMPLE = 1000;
const DAYS_PER_MONTH = 30;

/** Rows: the host's switches and those of plugins that are on (by stamped key). Reactive. */
const rows = (): Partial<Record<JevFeature, JevFeatureInfo>> => ({ ...JEV_FEATURE_INFO, ...pluginJevFeatures() });
/** A switch's row; a bare one named by its declaration while its plugin's row is gone (it just turned off). Reactive. */
const featureInfo = (f: JevFeature): Omit<JevFeatureInfo, 'group'> & { group?: JevFeatureInfo['group'] } =>
  rows()[f] ?? { label: jevFeatureLabel(f), hint: '' };
/**
 * Switches with a row here, in page order (orderJevFeatures: host order, plugins' placed as declared, by group). A switch
 * that turns a managed rule on is the rule's, in Settings → Rules. Reactive.
 */
const ordered = (): JevFeature[] => {
  const info = rows();
  const shown = (f: JevFeature): boolean => !!info[f] && !managedRuleFeatures().includes(f);
  return orderJevFeatures(HOST_JEV_FEATURES, bundledJevFeatures(), (f) => (shown(f as JevFeature) ? info[f as JevFeature]!.group : undefined)) as JevFeature[];
};

/** What a query counts as, in a few words: "Alert when yes ≥ 70%". */
function conditionText(d: JevQueryDef): string {
  const q = effectiveJevQuery(d, jevQueryOverrides());
  const type = { noul: 'Yes / no', choice: 'Pick one', score: 'Score' }[q.type];
  if (d.condition === null) return type;
  const when = q.type === 'score' ? `score ≥ ${q.minScore}` : `${q.type === 'noul' ? 'yes' : 'a ticked option'} ≥ ${percentText(q.minProbability)}`;
  return `${type} · ${d.condition.toLowerCase()} when ${when}`;
}

/** Settings → Jev: its features, or (the Queries view) every question the app asks it. */
export function JevSection() {
  return (
    <Show when={jevView() === 'queries'} fallback={<JevFeatures />}>
      <JevQueriesSection />
    </Show>
  );
}

/** Jev (TypeSafe's decision model via the OpenRouter key): an overview, then one section per feature with its switch. */
function JevFeatures() {
  const status = jevStatus;
  const switchFor = (f: JevFeature, id?: string) => (
    <Switch id={id} label={featureInfo(f).label} checked={jevFeatureOn(aiSettings().jev, f)} disabled={jevFeatureLocked(f)} onChange={(on) => toggleJevFeature(f, on)} />
  );
  const statusText = (): string => {
    const s = status();
    if (!s) return 'Checking…';
    if (s.connection === 'typesafe') return s.available ? `${s.model} · direct to TypeSafe` : 'Add a TypeSafe key under Connection';
    return s.available ? `${s.model} · paid by key ${s.keyLabel}` : 'Add Jev to an OpenRouter key under AI → OpenRouter';
  };
  const onCount = () => ordered().filter((f) => jevFeatureOn(aiSettings().jev, f)).length;
  const overview = {
    id: 'overview',
    label: 'Overview',
    meta: () => `${status()?.available ? 'Ready' : 'Not set up'} · ${onCount()} of ${ordered().length} on`,
    title: 'Overview',
    body: () => (
      <>
        <Stats>
          <Stat label="Status" value={status()?.available ? 'Ready' : 'Not set up'} note={statusText()} />
          <Stat label="Per question" value={usdText(usdPerQuestion())} note="your recent average once Jev has run" />
          <Stat label="Today" value={usdText(jevUseToday(Date.now()).usd)} note={`${usdText(jevUseRecent(Date.now()).usd)} recently`} />
        </Stats>
        <JevConnectionCard status={status()} changed={refetchJevStatus} />
        {/* The keys live under the provider paid through them; without one running, Jev's own connection keeps them. */}
        <Show when={aiSettings().jevConnection === 'openrouter' && !availableProviders().some((d) => d.openRouterKeys)}>
          <OpenRouterKeys models={null} />
        </Show>
        <Note>
          At {PER_DAY_EXAMPLE.toLocaleString()} messages a day, each per-message question is roughly {usdText(usdPerQuestion() * PER_DAY_EXAMPLE * DAYS_PER_MONTH)} a month;
          turning one on also checks the last day.{' '}
          {status()?.connection === 'typesafe'
            ? 'Jev bills to your TypeSafe account. TypeSafe reports tokens, not cost, so costs here use its published price. If TypeSafe stops answering, everything works as without Jev.'
            : 'Jev bills to the OpenRouter key that lists it. A key that reaches its OpenRouter cap stops Jev until it resets; everything then works as without Jev.'}
        </Note>
        <Show when={status()?.lastError}>
          {(e) => (
            <Note kind="error">
              Last Jev error ({new Date(e().at).toLocaleTimeString()}): {e().message}
            </Note>
          )}
        </Show>
      </>
    ),
  };
  const bodies = new Map<JevFeature, () => JSX.Element>();
  const body = (f: JevFeature) => {
    if (!bodies.has(f)) bodies.set(f, () => <FeatureBody feature={f} control={switchFor(f, `jev-${f}`)} />);
    return bodies.get(f)!;
  };

  return (
    <SectionsPage
      id="jev"
      title="Jev"
      right={<JevViewSwitch />}
      lede="A decision model: it answers yes/no, pick-one and score questions about text, fast and cheaply, and never writes text. Each feature sends message text to TypeSafe."
      sections={[
        overview,
        ...ordered().map((f) => ({
          id: f,
          label: featureInfo(f).label,
          group: featureInfo(f).group,
          muted: () => !jevFeatureOn(aiSettings().jev, f),
          aside: () => switchFor(f),
          body: body(f),
        })),
      ]}
    />
  );
}

function FeatureBody(props: { feature: JevFeature; control: JSX.Element }) {
  const info = featureInfo(props.feature);
  const asks = JEV_QUERIES.filter((d) => d.features.includes(props.feature));
  return (
    <>
      <Card>
        <Row label="On" for={`jev-${props.feature}`} hint={info.hint} control={props.control} />
        <Row label="Cost" hint={info.perMessage ? `${info.perMessage}.` : 'Only when the feature runs; nothing per new message.'} />
      </Card>
      <Show when={asks.length}>
        <Card title="Questions it asks Jev" meta="Edit the wording, type and threshold under Queries">
          <For each={asks}>
            {(d) => (
              <Row
                label={d.label}
                hint={conditionText(d)}
                control={
                  <button type="button" class={`cp-button ${styles.button}`} onClick={() => showJevQuery(d.id)}>
                    Edit…
                  </button>
                }
              />
            )}
          </For>
        </Card>
      </Show>
      <Show when={info.Body}>{(Body) => <Dynamic component={Body()} />}</Show>
    </>
  );
}

const CONNECTION_OPTIONS: { value: JevConnection; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter (a key that lists Jev)' },
  { value: 'typesafe', label: 'TypeSafe (direct, your TypeSafe key)' },
];

/** Which connection Jev uses, and the TypeSafe key for the direct one. OpenRouter keys are listed under the provider paid through them. */
function JevConnectionCard(props: { status: JevStatus | undefined; changed: () => void }) {
  const [pasted, setPasted] = createSignal('');
  const action = createAction();
  const { busy, error } = action;
  const run = (job: () => Promise<void>): Promise<unknown> =>
    action.run(async () => {
      await job();
      props.changed();
    });
  const choose = (v: string): void => {
    patchAiSettings({ jevConnection: v as JevConnection });
    props.changed();
  };
  return (
    <Card title="Connection">
      <Row
        label="Jev connects through"
        for="jev-connection"
        hint="Only the chosen connection is used; Jev never falls back to the other one."
        control={<Select id="jev-connection" class={c.select} value={aiSettings().jevConnection} options={CONNECTION_OPTIONS} onChange={choose} />}
      />
      <Show when={aiSettings().jevConnection === 'typesafe'}>
        <Show
          when={props.status?.typeSafeKeyHint}
          fallback={
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.typeSafe.setKey(pasted());
                  setPasted('');
                });
              }}
            >
              <Row
                label="TypeSafe key"
                for="typesafe-key"
                hint="From console.typesafe.ai/keys. Checked with TypeSafe, then stored encrypted on this PC."
                control={
                  <div class={c.buttons}>
                    <input
                      id="typesafe-key"
                      type="password"
                      autocomplete="off"
                      class={c.select}
                      value={pasted()}
                      onInput={(e) => setPasted(e.currentTarget.value)}
                    />
                    <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !pasted().trim()}>
                      {busy() ? 'Checking…' : 'Save key'}
                    </button>
                  </div>
                }
              />
            </form>
          }
        >
          {(hint) => (
            <Row
              label="TypeSafe key"
              hint={`Stored, ending ${hint()}.`}
              control={
                <button
                  type="button"
                  class={`cp-button ${styles.button}`}
                  disabled={busy()}
                  onClick={() => confirm('Remove the TypeSafe key from ChattyPop? It stays valid on TypeSafe.') && void run(api.typeSafe.removeKey)}
                >
                  Remove key
                </button>
              }
            />
          )}
        </Show>
      </Show>
      <ErrorNote error={error()} />
    </Card>
  );
}
