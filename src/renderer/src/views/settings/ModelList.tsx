// A provider's models as one picker row: each option names what the model can do. Shared by AI and feature settings.
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import type { ModelOption } from '@shared/contract';
import { SearchSelect } from '@/ui/SearchSelect';
import { formatBytes } from '@/ui/format';
import { Row, SettingsButton, settingsControl as c } from './SettingsLayout';

/** The picker's value while no listed model is picked. */
const NONE = '';

/** What a model can do and its size, in a few words. */
export const modelTraits = (m: ModelOption): string =>
  [m.isDefault ? 'provider default' : null, m.images ? 'reads images' : null, m.efforts?.length ? 'thinks' : null, m.bytes ? formatBytes(m.bytes) : null].filter(Boolean).join(' · ');

/** A model's line under its name: the provider's own description, then its traits. */
const modelNote = (m: ModelOption): string | undefined => [m.description, modelTraits(m)].filter(Boolean).join(' · ') || undefined;

export interface ModelListProps {
  /** The picker's element id: unique per page. */
  id: string;
  models: readonly ModelOption[];
  /** The picked model's id; null = `unset`. */
  value: string | null;
  /** What a null value picks: the provider's default (its isDefault model; the default) or nothing yet. */
  unset?: 'default' | 'none';
  onChange(id: string): void;
  /** Beside each model in a list under the picker, opened on request (Ollama's Delete). */
  action?: (m: ModelOption) => JSX.Element;
}

/** A provider's models in one searchable picker; a saved model no longer listed stays pickable. */
export function ModelList(props: ModelListProps) {
  const [managing, setManaging] = createSignal(false);
  const rows = createMemo((): ModelOption[] => {
    const listed = props.models;
    const saved = props.value;
    return saved && !listed.some((m) => m.id === saved) ? [{ id: saved, label: `${saved} (not listed)` }, ...listed] : [...listed];
  });
  const picked = createMemo(() => rows().find((m) => (props.value === null ? props.unset !== 'none' && !!m.isDefault : props.value === m.id)));
  const placeholder = (): string => (!rows().length ? 'No models listed' : props.unset === 'none' ? 'Pick a model…' : 'Provider default');
  return (
    <>
      <Row
        label="Model"
        for={props.id}
        hint={picked() && modelNote(picked()!)}
        control={
          <SearchSelect
            id={props.id}
            label="Model"
            searchLabel="Filter models"
            class={c.select}
            value={picked()?.id ?? NONE}
            placeholder={placeholder()}
            disabled={!rows().length}
            options={rows().map((m) => ({ value: m.id, label: m.label, note: modelNote(m) }))}
            onChange={(id) => props.onChange(id)}
          />
        }
      />
      <Show when={props.models.length > 0 && props.action}>
        {(action) => (
          <>
            <Row
              label={`${props.models.length} ${props.models.length === 1 ? 'model' : 'models'}`}
              control={
                <SettingsButton aria-expanded={managing()} onClick={() => setManaging(!managing())}>
                  {managing() ? 'Done' : 'Manage'}
                </SettingsButton>
              }
            />
            <Show when={managing()}>
              <For each={props.models}>{(m) => <Row label={m.label} hint={modelNote(m)} control={action()(m)} />}</For>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
