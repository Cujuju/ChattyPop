// Shared time-window field for message and timed actions.
import { Show } from 'solid-js';
import { ACTION_LOOKBACKS } from '@shared/rules';
import { Row, settingsControl as c } from '../SettingsLayout';
import { Select } from '@/ui/Select';
import type { KindProps } from './kinds/types';

const LOOKBACK_OPTIONS = ACTION_LOOKBACKS.map((x) => ({ value: String(x.ms), label: x.label }));

/** A message lookback picker or the timed window's read-only description. */
export function RuleLookback(props: KindProps<{ lookbackMs: number }>) {
  return (
    <Show when={!props.cover} fallback={<Row label="Covering" hint={props.cover} />}>
      <Row
        label="Covering"
        for={props.id}
        control={
          <Select
            id={props.id}
            class={c.select}
            value={String(props.config.lookbackMs)}
            options={LOOKBACK_OPTIONS}
            onChange={(ms) => props.onChange({ ...props.config, lookbackMs: Number(ms) })}
          />
        }
      />
    </Show>
  );
}
