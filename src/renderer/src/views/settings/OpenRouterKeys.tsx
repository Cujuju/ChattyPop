import { api } from '@/api';
import { For, Show, createResource, createSignal } from 'solid-js';
import type { ModelOption } from '@shared/contract';
import { JEV_OPENROUTER_MODEL, type OpenRouterKeyBalance, type OpenRouterKeyInfo, type OpenRouterKeyRouting } from '@shared/openrouter';
import { providerStatus, refetchProviderStatus } from '@/state/preferences';
import { inCompanion } from '@/state/ui';
import { createAction } from '@/ui/action';
import { usdText as usd } from '@/ui/format';
import { SearchSelect } from '@/ui/SearchSelect';
import { Switch } from '@/ui/Switch';
import { Card, ErrorNote, Note, Row, settingsControl as c } from './SettingsLayout';
import styles from './Settings.module.css';

const JEV_OPTION: ModelOption = { id: JEV_OPENROUTER_MODEL, label: 'Jev (TypeSafe decisions)' };

function balanceText(b: OpenRouterKeyBalance | { error: string } | undefined): string {
  if (!b) return 'Checking balance…';
  if ('error' in b) return `Balance unavailable: ${b.error}`;
  const reset = b.limitReset ? `, resets ${b.limitReset}` : '';
  if (b.limitUsd === null || b.remainingUsd === null) return `${usd(b.usageMonthlyUsd)} used this month · no cap`;
  return `${usd(b.remainingUsd)} of ${usd(b.limitUsd)} left${reset}`;
}

/** OpenRouter keys fund listed models or unlisted fallbacks. Key caps are external; capped keys stop without switching payment keys. */
export function OpenRouterKeys(props: { models: ModelOption[] | null }) {
  // Re-read whenever provider status refreshes, which every key change triggers.
  const [keysResource] = createResource(providerStatus, () => api.core.openRouterKeys());
  // Undefined while loading or failed: reading a failed resource throws.
  const keys = () => (keysResource.error ? undefined : keysResource());
  const [balancesResource] = createResource(keys, () => api.core.openRouterBalances());
  const balances = () => (balancesResource.error ? undefined : balancesResource());
  const action = createAction();
  const { busy, error } = action;
  const [label, setLabel] = createSignal('');
  const [pasted, setPasted] = createSignal('');

  const catalog = (): ModelOption[] => [JEV_OPTION, ...(props.models ?? [])];
  const labelOf = (id: string): string => catalog().find((m) => m.id === id)?.label ?? id;
  const run = (job: () => Promise<void>): Promise<unknown> =>
    action.run(async () => {
      await job();
      await refetchProviderStatus();
    });
  const update = (k: OpenRouterKeyInfo, patch: Partial<OpenRouterKeyRouting>): void =>
    void run(() => api.openRouter.updateKey(k.id, { label: k.label, models: k.models, anyModel: k.anyModel, ...patch }));
  /** Models no key lists yet: each model is paid by one key. */
  const unassigned = (): ModelOption[] => {
    const taken = new Set((keys() ?? []).flatMap((k) => k.models));
    return catalog().filter((m) => !taken.has(m.id));
  };

  return (
    <>
      <Note>
        Each key pays for the models it lists; one key can also cover any other model. Set each key's spending cap on openrouter.ai. When a key reaches it, requests
        on that key stop and no other key is used.
      </Note>
      <For each={keys() ?? []}>
        {(k) => (
          <Card title={k.label} meta={`${k.hint} · ${balanceText(balances()?.[k.id])}`}>
            <Row
              label="Name"
              for={`or-key-name-${k.id}`}
              control={<input id={`or-key-name-${k.id}`} class={c.select} value={k.label} onChange={(e) => update(k, { label: e.currentTarget.value })} />}
            />
            <Row
              label="Pays for"
              hint={k.models.length ? undefined : 'No models listed yet.'}
              control={
                <SearchSelect
                  class={c.select}
                  value=""
                  placeholder="Add a model to this key…"
                  disabled={busy()}
                  options={unassigned().map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(v) => v && update(k, { models: [...k.models, v] })}
                />
              }
            >
              <Show when={k.models.length}>
                <div class={c.buttons}>
                  <For each={k.models}>
                    {(m) => (
                      <span class={styles.usageWindow}>
                        {labelOf(m)}
                        <button type="button" class={`cp-button ${styles.button}`} disabled={busy()} aria-label={`Remove ${labelOf(m)} from ${k.label}`} onClick={() => update(k, { models: k.models.filter((x) => x !== m) })}>
                          Remove
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </Row>
            <Row
              label="Any other model"
              for={`or-key-any-${k.id}`}
              hint="Also pays for models no key lists."
              control={<Switch id={`or-key-any-${k.id}`} checked={k.anyModel} disabled={busy()} onChange={(on) => update(k, { anyModel: on })} />}
            />
            <Row
              label="Remove from ChattyPop"
              hint="The key stays valid on OpenRouter."
              control={
                <button
                  type="button"
                  class={`cp-button ${styles.button}`}
                  disabled={busy()}
                  onClick={() => confirm(`Remove key ${k.label} (${k.hint}) from ChattyPop? It stays valid on OpenRouter.`) && void run(() => api.openRouter.removeKey(k.id))}
                >
                  Remove key
                </button>
              }
            />
          </Card>
        )}
      </For>
      <Card title="Add a key">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const existing = keys() ?? [];
            const routing = { label: label().trim() || `OpenRouter key ${existing.length + 1}`, models: [], anyModel: !existing.some((k) => k.anyModel) };
            void run(async () => {
              await api.openRouter.addKey(pasted(), routing);
              setPasted('');
              setLabel('');
            });
          }}
        >
          <Row
            label="Name"
            for="openrouter-key-label"
            control={<input id="openrouter-key-label" class={c.select} placeholder="e.g. Jev only" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />}
          />
          <Row
            label="Key"
            for="openrouter-key"
            control={
              <input
                id="openrouter-key"
                type="password"
                autocomplete="off"
                class={c.select}
                placeholder="sk-or-v1-…"
                value={pasted()}
                onInput={(e) => setPasted(e.currentTarget.value)}
              />
            }
          />
          <Row
            label={inCompanion ? 'Save key' : 'Save it, or sign in instead'}
            control={
              <div class={c.buttons}>
                <button type="submit" class={`cp-button ${styles.button}`} disabled={busy() || !pasted().trim()}>
                  Save key
                </button>
                <Show when={!inCompanion}>
                  <button type="button" class={`cp-button ${styles.button}`} disabled={busy()} onClick={() => void run(api.openRouter.signIn)}>
                    {busy() ? 'Working…' : 'Sign in with OpenRouter'}
                  </button>
                </Show>
              </div>
            }
          />
          <Show when={inCompanion}>
            <Note>Sign in with OpenRouter on your PC, or paste a key here.</Note>
          </Show>
        </form>
      </Card>
      <ErrorNote error={error()} />

    </>
  );
}
