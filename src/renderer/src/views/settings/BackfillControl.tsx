import { Show } from 'solid-js';
import { BACKFILL_AMOUNT_MAX, BACKFILL_AMOUNT_MIN, DEFAULT_BACKFILL_HISTORY, clampBackfillAmount, type BackfillHistory, type BackfillUnit, type ChannelBackfillHistory } from '@shared/archiveSettings';
import { Select } from '@/ui/Select';
import { countText } from '@/ui/format';
import { NumberField, settingsControl as c } from './SettingsLayout';

const HISTORY_WORDS: Record<BackfillUnit, string> = { days: 'day', months: 'month', years: 'year' };
export const historyText = (history: BackfillHistory): string =>
  history === 'complete' ? 'complete history' : countText(history.amount, HISTORY_WORDS[history.unit]);

type BackfillControlProps =
  | { id?: string; value: BackfillHistory; onChange: (history: BackfillHistory) => void; defaultHistory?: undefined }
  | { id: string; value: ChannelBackfillHistory | undefined; onChange: (history: ChannelBackfillHistory | undefined) => void; defaultHistory: BackfillHistory };

/** History amount and unit, with optional per-channel default and fixed-time choices. */
export function BackfillControl(props: BackfillControlProps) {
  const id = () => props.id ?? 'backfill';
  const limited = () => {
    const history = props.value;
    return history && history !== 'complete' && 'unit' in history ? history : undefined;
  };
  const selected = () => {
    const history = props.value;
    return !history ? 'default' : history === 'complete' ? 'complete' : 'sinceMs' in history ? 'since' : history.unit;
  };
  const changeUnit = (value: string): void => {
    if (props.defaultHistory !== undefined && (value === 'default' || value === 'since')) {
      props.onChange(value === 'default' ? undefined : { sinceMs: Date.now() });
      return;
    }
    if (value === 'complete') {
      props.onChange('complete');
      return;
    }
    const unit = value as BackfillUnit;
    props.onChange({ unit, amount: clampBackfillAmount(unit, limited()?.amount ?? DEFAULT_BACKFILL_HISTORY.amount) });
  };
  return (
    <>
      <Show when={limited()}>
        {(history) => (
          <NumberField
            id={`${id()}-amount`}
            label="History amount"
            min={BACKFILL_AMOUNT_MIN}
            max={BACKFILL_AMOUNT_MAX[history().unit]}
            value={history().amount}
            onChange={(amount) => props.onChange({ unit: history().unit, amount: clampBackfillAmount(history().unit, amount) })}
          />
        )}
      </Show>
      <Select
        id={`${id()}-unit`}
        class={c.select}
        value={selected()}
        options={[
          ...(props.defaultHistory !== undefined ? [{ value: 'default', label: `Default (${historyText(props.defaultHistory)})` }] : []),
          { value: 'days', label: 'Days' },
          { value: 'months', label: 'Months' },
          { value: 'years', label: 'Years' },
          { value: 'complete', label: 'Complete history' },
          ...(props.defaultHistory !== undefined ? [{ value: 'since', label: 'No earlier history' }] : []),
        ]}
        onChange={changeUnit}
      />
    </>
  );
}
