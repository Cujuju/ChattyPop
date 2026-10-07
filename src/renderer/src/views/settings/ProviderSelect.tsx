// Features choose running providers, marking disabled AI settings. Model/effort follow each provider’s AI settings.
import { Select } from '@/ui/Select';
import type { ProviderId } from '@shared/settings';
import { availableProviders } from '@/state/aiProviders';
import { providerSettingsOf } from '@/state/preferences';
import { settingsControl as c } from './SettingsLayout';

/** The select's value while no provider is chosen. */
const NONE = '';

/** `class` replaces the settings-column width (a panel header's select); `label` names a select without a Row label. */
export function ProviderSelect(props: { id?: string; class?: string; label?: string; value: ProviderId | null; onChange: (id: ProviderId | null) => void }) {
  const options = () => [
    ...(props.value ? [] : [{ value: NONE, label: 'Pick a provider…' }]),
    // A chosen provider whose plugin isn't running keeps its row, so the choice stays visible.
    ...(props.value && !availableProviders().some((d) => d.id === props.value) ? [{ value: props.value, label: `${props.value} (not running)` }] : []),
    ...availableProviders().map((d) => ({ value: d.id, label: providerSettingsOf(d.id).enabled ? d.label : `${d.label} (turned off in Settings → AI providers)` })),
  ];
  return <Select id={props.id} class={props.class ?? c.select} label={props.label} value={props.value ?? NONE} options={options()} onChange={(v) => props.onChange(v || null)} />;
}
