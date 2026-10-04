// A provider's models as rows, one picked (docs/plugin-architecture.md §3, AI providers): what each can do, its size,
// a Use choice and an optional action. Settings → AI, Image text and Translation share it.
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import type { ModelOption } from '@shared/contract';
import { look } from '@/theme/look';
import { formatBytes } from '@/ui/format';
import { Note, Row } from './SettingsLayout';
import styles from './ModelList.module.css';

/** From this many models a filter field narrows the list: an installed handful needs none, OpenRouter's hundreds do. */
const FILTER_FROM = 12;
/** Rows drawn at once while filtering; typing narrows a long list below it. */
const MAX_SHOWN = 50;

/** What a model can do and its size, in a few words. */
export const modelTraits = (m: ModelOption): string =>
  [m.isDefault ? 'provider default' : null, m.images ? 'reads images' : null, m.efforts?.length ? 'thinks' : null, m.bytes ? formatBytes(m.bytes) : null].filter(Boolean).join(' · ');

export interface ModelListProps {
  /** The radio group's name: unique per page. */
  name: string;
  models: readonly ModelOption[];
  /** The picked model's id; null = `unset`. */
  value: string | null;
  /** What a null value picks: the provider's default (its isDefault model's row; the default) or nothing yet. */
  unset?: 'default' | 'none';
  onChange(id: string): void;
  /** Beside a model's Use choice (Ollama's Delete). */
  action?: (m: ModelOption) => JSX.Element;
}

/** A provider's models, one row each with a Use choice; a saved model no longer listed keeps its row. */
export function ModelList(props: ModelListProps) {
  const [query, setQuery] = createSignal('');
  const picked = (m: ModelOption): boolean => (props.value === null ? props.unset !== 'none' && !!m.isDefault : props.value === m.id);
  const rows = createMemo((): ModelOption[] => {
    const listed = props.models;
    const saved = props.value;
    return saved && !listed.some((m) => m.id === saved) ? [{ id: saved, label: `${saved} (not listed)` }, ...listed] : [...listed];
  });
  const filtering = () => rows().length >= FILTER_FROM;
  const matches = createMemo(() => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (m: ModelOption): boolean => picked(m) || words.every((w) => `${m.label} ${m.id}`.toLowerCase().includes(w));
    return rows().filter(hit);
  });
  const shown = () => (filtering() ? matches().slice(0, MAX_SHOWN) : rows());
  const pick = (m: ModelOption) => (
    <label class={`${styles.pick} ${look.toggleLabel} ${look.text}`} data-size="xs" data-tone="muted" data-font="sans">
      <input type="radio" name={props.name} aria-label={`Use ${m.label}`} checked={picked(m)} onChange={() => props.onChange(m.id)} />
      Use
    </label>
  );
  return (
    <div role="radiogroup" aria-label="Model">
      <Show when={filtering()}>
        <Row
          label={`${rows().length} models`}
          control={<input type="search" class={styles.filter} placeholder="Filter models" aria-label="Filter models" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />}
        />
      </Show>
      <For each={shown()}>
        {(m) => (
          <Row
            label={m.label}
            hint={modelTraits(m) || undefined}
            control={
              <>
                {props.action?.(m)}
                {pick(m)}
              </>
            }
          />
        )}
      </For>
      <Show when={filtering() && matches().length > MAX_SHOWN}>
        <Note>
          Showing {MAX_SHOWN} of {matches().length}. Type to narrow the list.
        </Note>
      </Show>
    </div>
  );
}
