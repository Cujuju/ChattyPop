import { Match, Show, Switch as Branch } from 'solid-js';
import { ALL_DAYS, DEFAULT_BACKFILL_HOURS, TIMED_HOURS_MAX, TIMED_HOURS_MIN, maxBackfillRuns, type TimedTrigger } from '@shared/ruleTime';
import { Select } from '@/ui/Select';
import { NumberField, settingsControl as c } from '../SettingsLayout';
import { Checks, Field } from './fields';
import { DAY_NAMES } from './summaries';

type Of<K extends TimedTrigger['kind']> = Extract<TimedTrigger, { kind: K }>;
/** Triggers with due times that can pass while ChattyPop is closed. */
type Scheduled = Of<'daily'> | Of<'every'>;

const DAY_ITEMS = ALL_DAYS.map((d) => ({ id: d, label: DAY_NAMES[d]! }));

const MISSED_OPTIONS = [
  { value: 'merge', label: 'Run once at the next start' },
  { value: 'each', label: 'Run each missed time' },
];

/** What a scheduled trigger does about due times that passed while ChattyPop was closed. */
function MissedRunsField(props: { id: string; trigger: Scheduled; onChange: (t: TimedTrigger) => void }) {
  const each = (): boolean => props.trigger.backfillHours !== undefined;
  const pick = (v: string): void => {
    const { backfillHours: _, ...rest } = props.trigger;
    props.onChange(v === 'each' ? { ...rest, backfillHours: DEFAULT_BACKFILL_HOURS } : rest);
  };
  const most = (): number => maxBackfillRuns(props.trigger);
  return (
    <>
      <Field
        label="If missed"
        for={`${props.id}-missed`}
        hint={each() ? 'Each missed time runs over its own stretch, oldest first.' : 'One run covers everything since the last.'}
      >
        <Select id={`${props.id}-missed`} class={c.select} value={each() ? 'each' : 'merge'} options={MISSED_OPTIONS} onChange={pick} />
      </Field>
      <Show when={each()}>
        <Field
          label="Going back"
          for={`${props.id}-backfill`}
          hint={`Missed times due longer ago are skipped: at most ${most()} ${most() === 1 ? 'run' : 'runs'} per start.`}
        >
          <NumberField
            id={`${props.id}-backfill`}
            min={TIMED_HOURS_MIN}
            max={TIMED_HOURS_MAX}
            value={props.trigger.backfillHours ?? DEFAULT_BACKFILL_HOURS}
            unit="hours"
            onChange={(n) => Number.isFinite(n) && props.onChange({ ...props.trigger, backfillHours: n })}
          />
        </Field>
      </Show>
    </>
  );
}

/** A timed trigger's own fields: the time and days, the interval, or the absence that starts it. */
export function TimedTriggerFields(props: { id: string; trigger: TimedTrigger; onChange: (t: TimedTrigger) => void }) {
  const as = <K extends TimedTrigger['kind']>(kind: K): Of<K> | false => props.trigger.kind === kind && (props.trigger as Of<K>);
  return (
    <Branch>
      <Match when={as('daily')}>
        {(t) => (
          <>
            <Field label="At" for={`${props.id}-at`}>
              <input id={`${props.id}-at`} type="time" class={c.number} value={t().at} onChange={(e) => e.currentTarget.value && props.onChange({ ...t(), at: e.currentTarget.value })} />
              <Checks items={DAY_ITEMS} chosen={t().days} onChange={(days) => props.onChange({ ...t(), days: [...days].sort((a, b) => a - b) })} />
            </Field>
            <MissedRunsField id={props.id} trigger={t()} onChange={props.onChange} />
          </>
        )}
      </Match>
      <Match when={as('every')}>
        {(t) => (
          <>
            <Field label="Every" for={`${props.id}-hours`} hint="From its last run.">
              <NumberField id={`${props.id}-hours`} min={TIMED_HOURS_MIN} max={TIMED_HOURS_MAX} value={t().hours} unit="hours" onChange={(n) => Number.isFinite(n) && props.onChange({ ...t(), hours: n })} />
            </Field>
            <MissedRunsField id={props.id} trigger={t()} onChange={props.onChange} />
          </>
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
