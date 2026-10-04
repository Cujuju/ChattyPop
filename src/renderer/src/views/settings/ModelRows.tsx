import { Show } from 'solid-js';
import type { ModelOption, ProviderStatus } from '@shared/contract';
import type { ProviderId } from '@shared/settings';
import { providerStatus } from '@/state/preferences';
import { SearchSelect } from '@/ui/SearchSelect';
import { EffortSelect, hasEffortChoice, keptEffort } from './EffortSelect';
import { Row, settingsControl as c } from './SettingsLayout';

export const statusOf = (id: ProviderId): ProviderStatus | undefined => providerStatus().find((s) => s.id === id);

/** The listed model a request uses: the chosen one, else the provider's default; undefined when not listed. */
export const modelOption = (id: ProviderId, modelId: string | null): ModelOption | undefined =>
  statusOf(id)?.models?.find((m) => (modelId ? m.id === modelId : m.isDefault));

/** A feature's model and effort for one provider: a null model is the provider's Settings → AI model. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

interface RowProps {
  /** Unique per page: labels point at it. */
  fieldId: string;
  provider: ProviderId;
  value: ModelChoice;
  onChange: (patch: Partial<ModelChoice>) => void;
}

export function ModelRow(props: RowProps) {
  const status = () => statusOf(props.provider);
  const current = () => props.value.model ?? '';
  // Keep a saved model selectable even if the provider stopped listing it.
  const options = () => {
    const models = status()?.models ?? [];
    return current() && !models.some((m) => m.id === current()) ? [{ id: current(), label: `${current()} (not listed)` }, ...models] : models;
  };
  return (
    <Row
      label="Model"
      for={props.fieldId}
      control={
        <Show when={status()} fallback={<span class={c.unit}>Loading models…</span>}>
          <SearchSelect
            id={props.fieldId}
            class={c.select}
            value={current()}
            disabled={!status()?.models}
            options={[{ value: '', label: 'Settings → AI model' }, ...options().map((m) => ({ value: m.id, label: m.label }))]}
            onChange={(v) => {
              const model = v || null;
              props.onChange({ model, effort: keptEffort(props.value.effort, modelOption(props.provider, model)) });
            }}
          />
        </Show>
      }
    />
  );
}

/** The chosen model's thinking/effort levels; hidden when it offers none. */
export function EffortRow(props: RowProps) {
  const model = () => modelOption(props.provider, props.value.model);
  return (
    <Show when={hasEffortChoice(model(), props.value.effort)}>
      <Row
        label="Thinking"
        for={props.fieldId}
        hint="How much the model reasons before answering. Higher is slower and uses more of your plan or credits."
        control={<EffortSelect id={props.fieldId} model={model()} value={props.value.effort} onChange={(effort) => props.onChange({ effort })} />}
      />
    </Show>
  );
}
