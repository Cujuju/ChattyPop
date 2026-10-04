// Rule-template views: shared data, so a plugin's templates can be built outside the renderer. Their ids and placement
// are the descriptor's `slots.ruleTemplates` (./slots).
import type { RuleAction, RuleMatch, RuleNarrow, RuleTrigger } from '@shared/rules';

/** A starting point in Settings → Rules → New rule. `make` returns the new rule's match, narrow and actions. */
export interface RuleTemplate {
  title: string;
  /** What it matches → what it does, as pills. */
  flow: [string, string];
  hint: string;
  make: () => { trigger?: RuleTrigger; match?: RuleMatch; narrow?: RuleNarrow; actions: RuleAction[]; missed?: boolean };
}
