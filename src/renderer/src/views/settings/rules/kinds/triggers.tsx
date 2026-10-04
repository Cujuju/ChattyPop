// Trigger picker choices, editors and summaries.
import { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
import { newTimedTrigger, timedTriggerText, type TimedTrigger } from '@shared/ruleTime';
import type { KindView } from './types';
import { TimedTriggerFields } from '../TimedTriggerFields';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A trigger editor may offer several picker choices for its configuration variants. */
export interface TriggerView<C = unknown> extends KindView<C> {
  choices?: { value: string; label: string; create(): C }[];
  choice?(config: C): string;
}
const view = <C,>(v: TriggerView<C>): TriggerView => v as TriggerView;
/** What starts a rule, its picker choices and its configuration editor. */
export const triggerViews: Record<string, TriggerView> = {
  [MESSAGE_TRIGGER]: { Editor: () => null, summary: () => '' },
  timed: view<TimedTrigger>({
    Editor: (p) => <TimedTriggerFields id={p.id} trigger={p.config} onChange={p.onChange} />,
    summary: (c) => timedTriggerText(c, DAY_NAMES),
    choice: (c) => c.kind,
    choices: [
      { value: 'daily', label: 'A time of day', create: () => newTimedTrigger('daily') },
      { value: 'every', label: 'Every few hours', create: () => newTimedTrigger('every') },
      { value: 'appStart', label: 'Opening ChattyPop after time away', create: () => newTimedTrigger('appStart') },
    ],
  }),
};
