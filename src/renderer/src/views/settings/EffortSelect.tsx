import type { ModelOption } from '@shared/contract';
import { EFFORT_LABELS } from '@shared/settings';
import { Select } from '@/ui/Select';
import { settingsControl as c } from './SettingsLayout';

export const effortLabel = (effort: string): string => EFFORT_LABELS[effort] ?? effort;

/** `effort` when `model` accepts it, else null (provider default): a model change keeps only a level the new model lists. */
export const keptEffort = (effort: string | null, model: ModelOption | undefined): string | null => (effort && model?.efforts?.includes(effort) ? effort : null);

/** Whether there is anything to pick: the model lists levels, or a saved level must stay visible. */
export const hasEffortChoice = (model: ModelOption | undefined, value: string | null): boolean => !!(model?.efforts?.length || value);

/** No level picked: the provider's default unless `unsetLabel` names what applies instead. */
const DEFAULT_UNSET_LABEL = 'Provider default';

/**
 * A thinking/effort picker for one model; a saved level the model no longer lists stays visible.
 * `class` replaces the settings-column width (a panel header's select); `label` names a select without a Row label.
 */
export function EffortSelect(props: { id?: string; class?: string; label?: string; unsetLabel?: string; model: ModelOption | undefined; value: string | null; onChange: (effort: string | null) => void }) {
  const efforts = () => props.model?.efforts ?? [];
  const options = () => {
    const listed = efforts().map((e) => ({ value: e, label: effortLabel(e) }));
    const saved = props.value;
    return saved && !efforts().includes(saved) ? [{ value: saved, label: `${effortLabel(saved)} (not supported)` }, ...listed] : listed;
  };
  return (
    <Select
      id={props.id}
      class={props.class ?? c.select}
      label={props.label}
      value={props.value ?? ''}
      options={[{ value: '', label: props.unsetLabel ?? DEFAULT_UNSET_LABEL }, ...options()]}
      onChange={(v) => props.onChange(v || null)}
    />
  );
}
