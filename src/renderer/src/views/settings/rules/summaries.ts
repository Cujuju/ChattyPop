// The rule list's one-line description of a rule.
import {
  actionsText,
  type Rule,
  type RuleMatch,
  type RuleNarrow,
  type RuleTrigger,
} from '@shared/rules';
import { kindView } from './kinds';

/** Weekday names, Sunday first (Date.getDay order). */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** What starts a tag or timed rule; null for the usual new message. */
function triggerText(t: RuleTrigger): string | null {
  return kindView('triggers', t.type)?.summary(t.config) || null;
}

/** The narrowing, e.g. "Voice message, Link to youtube.com, tagged sale"; empty when none. */
function narrowText(n: RuleNarrow): string {
  return n
    .map((p) => kindView('filters', p.type)?.summary(p.config))
    .filter(Boolean)
    .join(', ');
}

/** The ways the rule matches (any one is enough), else what the narrowing alone takes; empty when neither. */
function conditionsText(m: RuleMatch, n: RuleNarrow): string {
  const ways = m
    .map((p) => kindView('match', p.type)?.summary(p.config))
    .filter(Boolean)
    .join(', or ');
  const narrowing = narrowText(n);
  if (!ways) return narrowing;
  return narrowing ? `${ways}; with ${narrowing}` : ways;
}

/** What matches, else "Every message". */
const matchText = (m: RuleMatch, n: RuleNarrow): string => conditionsText(m, n) || 'Every message';

/** The rule list's second line: what starts it and matches → what it does. */
export function ruleLine(r: Rule): string {
  const trigger = triggerText(r.spec.trigger);
  const what = trigger
    ? [trigger, conditionsText(r.spec.match, r.spec.narrow)].filter(Boolean).join('; ')
    : matchText(r.spec.match, r.spec.narrow);
  const cap = what.charAt(0).toUpperCase() + what.slice(1);
  return `${cap} → ${actionsText(r.spec.actions)}`;
}
