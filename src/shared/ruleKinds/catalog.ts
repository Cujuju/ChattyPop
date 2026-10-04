// Host kind catalog without the bundled plugin registry.
import type { RuleSections, RuleSection } from './types';
import { message, timed, text, meaning, jev, contains, linkPlatforms, linkDomains, file, command } from './host';

/** Host declarations, independent of the bundled registry. */
export const HOST: { [S in RuleSection]: RuleSections[S][] } = {
  triggers: [message, timed],
  match: [text, meaning, jev],
  filters: [contains, linkPlatforms, linkDomains],
  actions: [file, command],
};
