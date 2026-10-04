import type { ModelOption } from '@shared/contract';
import { EFFORT_LABELS } from '@shared/settings';
import { Select } from '@/ui/Select';
import { settingsControl as c } from './SettingsLayout';

export const effortLabel = (effort: string): string => EFFORT_LABELS[effort] ?? effort;

/** `effort` when `model` accepts it, else null (provider default): a model change keeps only a level the new model lists. */
export const keptEffort = (effort: string | null, model: ModelOption | undefined): string | null => (effort && model?.efforts?.includes(effort) ? effort : null);

/** Whether there is anything to pick: the model lists levels, or a saved level must stay visible. */
export const hasEffortChoice = (model: ModelOption | undefined, value: string | null): boolean => !!(model?.efforts?.length || value);

/** A thinking/effort picker for one model; a saved level the model no longer lists stays visible. */
export function EffortSelect(props: { id: string; model: ModelOption | undefined; value: string | null; onChange: (effort: string | null) => void }) {
  const efforts = () => props.model?.efforts ?? [];
  const options = () => {
    const listed = efforts().map((e) => ({ value: e, label: effortLabel(e) }));
    const saved = props.value;
    return saved && !efforts().includes(saved) ? [{ value: saved, label: `${effortLabel(saved)} (not supported)` }, ...listed] : listed;
  };
  return (
    <Select
      id={props.id}
      class={c.select}
      value={props.value ?? ''}
      options={[{ value: '', label: 'Provider default' }, ...options()]}
      onChange={(v) => props.onChange(v || null)}
    />
  );
}
