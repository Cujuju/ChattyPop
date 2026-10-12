import { Show } from 'solid-js';
import { BACKFILL_AMOUNT_MAX, BACKFILL_AMOUNT_MIN, DEFAULT_BACKFILL_HISTORY, clampBackfillAmount, type BackfillHistory, type BackfillUnit } from '@shared/archiveSettings';
import { Select } from '@/ui/Select';
import { NumberField, settingsControl as c } from './SettingsLayout';

/** History amount followed by its unit; complete history has no amount. */
export function BackfillControl(props: { value: BackfillHistory; onChange: (history: BackfillHistory) => void }) {
  const limited = () => props.value === 'complete' ? undefined : props.value;
  const changeUnit = (value: string): void => {
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
            id="backfill-amount"
            label="History amount"
            min={BACKFILL_AMOUNT_MIN}
            max={BACKFILL_AMOUNT_MAX[history().unit]}
            value={history().amount}
            onChange={(amount) => props.onChange({ unit: history().unit, amount: clampBackfillAmount(history().unit, amount) })}
          />
        )}
      </Show>
      <Select
        id="backfill-unit"
        class={c.select}
        value={limited()?.unit ?? 'complete'}
        options={[
          { value: 'days', label: 'Days' },
          { value: 'months', label: 'Months' },
          { value: 'years', label: 'Years' },
          { value: 'complete', label: 'Complete history' },
        ]}
        onChange={changeUnit}
      />
    </>
  );
}
