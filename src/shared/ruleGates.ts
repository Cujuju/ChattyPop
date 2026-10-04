// Default gates shared by host and plugin rule factories.
import type { RuleGates } from './rules';

/** Gates of a new rule: anywhere, anyone, new messages only. */
export const newGates = (): RuleGates => ({
  edits: false,
  missed: false,
});
