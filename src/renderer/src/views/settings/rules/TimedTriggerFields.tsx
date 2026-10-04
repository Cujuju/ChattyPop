import { Match, Switch as Branch } from 'solid-js';
import { ALL_DAYS, TIMED_HOURS_MAX, TIMED_HOURS_MIN, type TimedTrigger } from '@shared/ruleTime';
import { NumberField, settingsControl as c } from '../SettingsLayout';
import { Checks, Field } from './fields';
import { DAY_NAMES } from './summaries';

type Of<K extends TimedTrigger['kind']> = Extract<TimedTrigger, { kind: K }>;

const DAY_ITEMS = ALL_DAYS.map((d) => ({ id: d, label: DAY_NAMES[d]! }));

/** A timed trigger's own fields: the time and days, the interval, or the absence that starts it. */
export function TimedTriggerFields(props: { id: string; trigger: TimedTrigger; onChange: (t: TimedTrigger) => void }) {
  const as = <K extends TimedTrigger['kind']>(kind: K): Of<K> | false => props.trigger.kind === kind && (props.trigger as Of<K>);
  return (
    <Branch>
      <Match when={as('daily')}>
        {(t) => (
          <Field label="At" for={`${props.id}-at`} hint="If closed then, runs at next start.">
            <input id={`${props.id}-at`} type="time" class={c.number} value={t().at} onChange={(e) => e.currentTarget.value && props.onChange({ ...t(), at: e.currentTarget.value })} />
            <Checks items={DAY_ITEMS} chosen={t().days} onChange={(days) => props.onChange({ ...t(), days: [...days].sort((a, b) => a - b) })} />
          </Field>
        )}
      </Match>
      <Match when={as('every')}>
        {(t) => (
          <Field label="Every" for={`${props.id}-hours`} hint="From its last run.">
            <NumberField id={`${props.id}-hours`} min={TIMED_HOURS_MIN} max={TIMED_HOURS_MAX} value={t().hours} unit="hours" onChange={(n) => Number.isFinite(n) && props.onChange({ ...t(), hours: n })} />
          </Field>
        )}
      </Match>
      <Match when={as('appStart')}>
        {(t) => (
          <Field label="After being away" for={`${props.id}-away`} hint="Once per start, if closed at least this long.">
            <NumberField
              id={`${props.id}-away`}
              min={TIMED_HOURS_MIN}
              max={TIMED_HOURS_MAX}
              value={t().awayHours}
              unit="hours"
              onChange={(n) => Number.isFinite(n) && props.onChange({ ...t(), awayHours: n })}
            />
          </Field>
        )}
      </Match>
    </Branch>
  );
}
