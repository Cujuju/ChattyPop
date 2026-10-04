// Named configuration bags keep rule fixture call sites concise.
import type { Platform } from '@shared/links';
import type { ContentKind } from '@shared/messageContent';
import type { PatternSpec } from '@shared/keywordPattern';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import type { TimedTrigger } from '@shared/ruleTime';

/** Fixture inputs retain the v3 trigger spelling; ruleInput converts them to v4 parts. */
export type LegacyRuleTrigger =
  { kind: 'message' } | { kind: 'tagApplied'; tagIds: number[]; sources: TagTriggerSource[] } | TimedTrigger;
/** Who applying a tag starts a rule: Jev, or the owner by hand. */
export type TagTriggerSource = 'jev' | 'manual';

/**
 * What makes a message match: any one set field is enough. None set: every message that passes the gates and LegacyRuleNarrow
 * matches (e.g. every voice message). `meaning` and `jev` need the message trigger.
 */
export interface LegacyRuleMatch {
  /** Keywords or /regex/; `spec` is the builder rule it was made from. */
  text?: { pattern: string; spec: PatternSpec | null };
  /** A plain-words subject Jev matches by meaning (Settings → Jev → rules by meaning). */
  meaning?: string;
  /** Jev's answer to the owner's question meets its condition (Settings → Jev → rules with a Jev question). */
  jev?: CustomJevQuestion;
}

/** Narrows a match: every set field must also hold. */
export interface LegacyRuleNarrow {
  /** Carries any of these. */
  contains?: ContentKind[];
  /** Shares a link on any of these platforms. */
  linkPlatforms?: Platform[];
  /** Shares a link to any of these sites (a site covers its subdomains). */
  linkDomains?: string[];
  /** Carries any of these tags now. */
  tagIds?: number[];
}
