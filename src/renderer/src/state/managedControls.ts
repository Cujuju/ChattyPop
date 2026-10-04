// Managed-rule switches supplied by the active owner's renderer contribution.
import type { Rule } from '@shared/rules';

/** A managed rule's switch and the optional Jev switch it replaces (`F`: the owner's switch keys, stamped by the host). */
export interface ManagedRuleControl<F extends string = string> {
  feature?: F;
  locked(): boolean;
  setEnabled(on: boolean): void | Promise<void>;
}
let read: (rule: Rule) => ManagedRuleControl | undefined = () => undefined;
/** Installs the registry's reactive lookup after bundled entries initialize. */
export const bindManagedControls = (lookup: typeof read): void => { read = lookup; };
/** The active owner's switch for a managed rule. */
export const managedControl = (rule: Rule): ManagedRuleControl | undefined => read(rule);
