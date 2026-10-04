// Editable Jev questions and their answer conditions.
import { Show, createUniqueId } from 'solid-js';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { JevQuestionBuilder, specStarter, type JevKind, type Renamed } from './JevQuestionBuilder';
import styles from './JevQuestionField.module.css';
import { look } from '@/theme/look';

const PERCENT = 100;
/** Starts where built-in Jev matching starts (0.7): precision first; tune from alert history. */
const DEFAULT_MIN_PROBABILITY = 0.7;
/** The top of the starter's three levels: precision first, as with the probability default. */
const DEFAULT_MIN_SCORE = 2;
const PERCENT_STEP = 5;
const PERCENT_MIN = 5;
const PERCENT_MAX = 95;
/** Score conditions may sit between two levels (Jev's score is an expected level, e.g. 1.5). */
const HALF_LEVEL = 0.5;

type Of<K extends JevKind> = Extract<CustomJevQuestion, { type: K }>;

/** A fresh question of `kind` with its condition: the first option counts, at the default thresholds. */
function starter(kind: JevKind): CustomJevQuestion {
  const spec = specStarter(kind);
  switch (spec.type) {
    case 'noul':
      return { ...spec, minProbability: DEFAULT_MIN_PROBABILITY };
    case 'choice':
      return { ...spec, alertOn: [spec.options[0]!.name], minProbability: DEFAULT_MIN_PROBABILITY };
    case 'score':
      return { ...spec, minScore: Math.min(DEFAULT_MIN_SCORE, spec.levels.length - 1) };
  }
}

/** Keeps the condition valid after a builder edit: renamed options stay ticked, removed ones and levels drop out. */
function reconcile(q: CustomJevQuestion | null, renamed?: Renamed): CustomJevQuestion | null {
  if (q?.type === 'choice') {
    const names = q.options.map((o) => o.name);
    return { ...q, alertOn: q.alertOn.map((a) => (a === renamed?.from ? renamed.to : a)).filter((a) => names.includes(a)) };
  }
  if (q?.type === 'score') return { ...q, minScore: Math.min(q.minScore, q.levels.length - 1) };
  return q;
}


export interface ConditionWording {
  legend: string;
  placeholder: string;
  /** What a met condition does, as a short verb ("Alert", "Keep the message"); badges the score levels that count. */
  verb: string;
  yes: string;
  choice: string;
  tick: string;
  choiceHint: string;
  level: string;
}

/** Wording for a condition that does `verb` when met ("Alert", "Keep the message"). */
export const conditionWording = (verb: string, legend: string, placeholder: string): ConditionWording => ({
  legend,
  placeholder,
  verb,
  yes: `${verb} when yes is at least`,
  choice: `${verb} when a ticked option is at least`,
  tick: `Ticked options count: ${verb.toLowerCase()}`,
  choiceHint: 'Ticked options count when Jev is at least that sure.',
  level: `${verb} when the score is at least`,
});

/** What a met condition does: a rule alerts, a tag is applied. */
const WORDING = {
  alert: conditionWording('Alert', 'Jev question', 'e.g. Does `message` offer something for sale?'),
} as const;

/** The probability ends of a threshold slider, in words. */
const PROBABILITY_SCALE = ['More often, less sure', 'Only when Jev is sure'];

/**
 * An owner-written Jev question and which answers meet it: a rule's match, when a tag applies, or a built-in
 * query's condition (Settings → Jev → Queries), with the parts the app reads locked.
 */
export function JevQuestionField(props: {
  value: CustomJevQuestion | null;
  onChange: (q: CustomJevQuestion | null) => void;
  action?: keyof typeof WORDING;
  /** Overrides `action`'s wording. */
  wording?: ConditionWording;
  /** A surrounding label shows the legend already. */
  legendHidden?: boolean;
  /** Offers "No Jev question". Default true. */
  optional?: boolean;
  /** Shows the condition (threshold, ticks, level). Default true. */
  showCondition?: boolean;
  kinds?: JevKind[];
  lockOptionNames?: boolean;
  lockLevelCount?: boolean;
  hideOptions?: boolean;
  /** The full-width layout (Settings → Jev → Queries). */
  roomy?: boolean;
}) {
  const w = () => props.wording ?? WORDING[props.action ?? 'alert'];
  const condition = () => props.showCondition !== false;
  const set = (patch: Partial<CustomJevQuestion>): void => props.onChange({ ...props.value!, ...patch } as CustomJevQuestion);
  const choice = () => props.value?.type === 'choice' && (props.value as Of<'choice'>);
  const alertOn = (): string[] => (choice() || null)?.alertOn ?? [];
  const score = () => props.value?.type === 'score' && (props.value as Of<'score'>);
  const levelId = createUniqueId();
  const levelTag = (level: number): string | null => {
    const s = score();
    return condition() && s && level >= Math.ceil(s.minScore) ? w().verb : null;
  };
  return (
    <JevQuestionBuilder
      legend={w().legend}
      legendHidden={props.legendHidden}
      optional={props.optional !== false}
      placeholder={w().placeholder}
      value={props.value}
      starter={starter}
      kinds={props.kinds}
      lockOptionNames={props.lockOptionNames}
      lockLevelCount={props.lockLevelCount}
      hideOptions={props.hideOptions}
      roomy={props.roomy}
      levelTag={levelTag}
      onChange={(q, renamed) => props.onChange(reconcile(q, renamed))}
      optionLead={
        condition()
          ? (name) => (
              <input
                type="checkbox"
                title={w().tick}
                aria-label={w().tick}
                checked={alertOn().includes(name)}
                onChange={(e) => set({ alertOn: e.currentTarget.checked ? [...alertOn(), name] : alertOn().filter((x) => x !== name) })}
              />
            )
          : undefined
      }
    >
      <Show when={condition()}>
        <Show when={props.value?.type === 'noul' && (props.value as Of<'noul'>)}>
          {(n) => <Probability text={w().yes} value={n().minProbability} onChange={(v) => set({ minProbability: v })} />}
        </Show>
        <Show when={choice()}>
          {(c) => (
            <Probability text={w().choice} value={c().minProbability ?? DEFAULT_MIN_PROBABILITY} onChange={(v) => set({ minProbability: v })} note={props.hideOptions ? undefined : w().choiceHint} />
          )}
        </Show>
        <Show when={score()}>
          {(s) => (
            <div class={`cp-condition ${look.card}`}>
              <label class={styles.conditionText} for={levelId}>
                {w().level} <span class={styles.conditionValue}>{s().minScore}</span>
                {Number.isInteger(s().minScore) ? '' : ` (between levels ${Math.floor(s().minScore)} and ${Math.ceil(s().minScore)})`}
              </label>
              <input
                id={levelId}
                class={styles.conditionRange}
                type="range"
                min={0}
                max={s().levels.length - 1}
                step={HALF_LEVEL}
                value={s().minScore}
                onInput={(e) => set({ minScore: Number(e.currentTarget.value) })}
              />
              <div class={styles.scale} aria-hidden="true">
                {s().levels.map((_, i) => (
                  <span>{i}</span>
                ))}
              </div>
            </div>
          )}
        </Show>
      </Show>
    </JevQuestionBuilder>
  );
}

/** A probability threshold: the condition as a sentence with its value, and a percentage slider. */
function Probability(props: { text: string; value: number; onChange: (v: number) => void; note?: string }) {
  return (
    <div class={`cp-condition ${look.card}`}>
      <label class={styles.conditionText}>
        {props.text} <span class={styles.conditionValue}>{Math.round(props.value * PERCENT)}%</span>
        <input
          class={styles.conditionRange}
          type="range"
          min={PERCENT_MIN}
          max={PERCENT_MAX}
          step={PERCENT_STEP}
          value={Math.round(props.value * PERCENT)}
          onInput={(e) => props.onChange(Number(e.currentTarget.value) / PERCENT)}
        />
      </label>
      <div class={styles.scale} aria-hidden="true">
        <span>{PROBABILITY_SCALE[0]}</span>
        <span>{PROBABILITY_SCALE[1]}</span>
      </div>
      <Show when={props.note}>
        <p class="cp-hint">{props.note}</p>
      </Show>
    </div>
  );
}
