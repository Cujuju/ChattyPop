// Host declarations for message and timed triggers, matching, narrowing, files and commands.
import { buildPattern, compileKeywordPattern, type PatternSpec } from '../keywordPattern';
import { validateCondition, validateJevSpec, type CustomJevQuestion } from '../jevQuestion';
import { PLATFORMS, type Platform } from '../links';
import { isContentKinds, type ContentKind } from '../messageContent';
import { newTimedTrigger, timedTriggerError, type TimedTrigger } from '../ruleTime';
import { MS_PER_HOUR, MS_PER_MIN } from '../units';
import {
  AFTER_MESSAGE,
  type RuleTriggerKind,
  type RuleMatchKind,
  type RuleFilterKind,
  type RuleActionKind,
} from './types';

/** The host trigger for new and edited archive messages. */
export const MESSAGE_TRIGGER = 'message';
/** Keywords or /regex/; spec is the builder rule it was made from. */
export interface TextConfig {
  pattern: string;
  spec: PatternSpec | null;
}

/** The absolute output path and append format for a message file. */
export interface FileConfig {
  path: string;
  format: RuleFileFormat;
}

/** A plugin command and the time before the triggering message that it covers. */
export interface CommandConfig {
  pluginId: string;
  commandId: string;
  lookbackMs: number;
}

/** Archive arrivals, including edits and missed messages when their gates allow them. */
export const message: RuleTriggerKind<null> = {
  type: MESSAGE_TRIGGER,
  label: 'A message',
  hint: '',
  event: 'message',
  create: () => null,
  validate() {},
};

/** Scheduled windows; each timing configuration determines its due time and range. */
export const timed: RuleTriggerKind<TimedTrigger> = {
  type: 'timed',
  label: 'A time of day',
  hint: '',
  event: 'window',
  create: () => newTimedTrigger('daily'),
  validate(c) {
    const error = timedTriggerError(c);
    if (error) throw new Error(error);
  },
};

/** A direct match on the keyword builder output or a written pattern. */
export const text: RuleMatchKind<TextConfig> = {
  type: 'text',
  label: 'Keywords',
  hint: '',
  asksJev: false,
  create: () => ({ pattern: '', spec: null }),
  validate(c) {
    compileKeywordPattern(c.spec ? buildPattern(c.spec) : c.pattern);
  },
};

/** A plain-words subject Jev matches by meaning when Settings → Jev enables it. */
export const meaning: RuleMatchKind<string> = {
  type: 'meaning',
  label: 'By meaning',
  hint: 'A subject in plain words; Jev finds messages about it.',
  asksJev: true,
  create: () => '',
  validate(c) {
    if (!c.trim()) throw new Error('Describe what the rule matches by meaning, or remove it.');
  },
};

/** A new yes/no condition starts at equally likely. */
const DEFAULT_YES_PROBABILITY = 0.5;
/** The answer to the owner’s Jev question must meet its configured condition. */
export const jev: RuleMatchKind<CustomJevQuestion> = {
  type: 'jev',
  label: 'Jev question',
  hint: '',
  asksJev: true,
  create: () => ({ type: 'noul', question: '', yes: '', no: '', minProbability: DEFAULT_YES_PROBABILITY }),
  validate(c) {
    validateJevSpec(c);
    validateCondition(c, {
      threshold: "Pick the Jev question's threshold between 0 and 100%.",
      options: 'Pick which options meet the Jev condition.',
      level: 'Pick the level the Jev answer must reach.',
    });
  },
};

/** Carries any of the selected content kinds. */
export const contains: RuleFilterKind<ContentKind[]> = {
  type: 'contains',
  label: 'Content',
  hint: '',
  create: () => [],
  validate(c) {
    if (!isContentKinds(c)) throw new Error('Pick what the messages contain again.');
  },
};

/** Shares a link on any selected platform. */
export const linkPlatforms: RuleFilterKind<Platform[]> = {
  type: 'linkPlatforms',
  label: 'Link platform',
  hint: '',
  create: () => [],
  validate(c) {
    if (c.some((p) => !PLATFORMS.includes(p))) throw new Error('Pick the link platforms again.');
  },
};

/** Shares a link to a selected site or one of its subdomains. */
export const linkDomains: RuleFilterKind<string[]> = {
  type: 'linkDomains',
  label: 'Site',
  hint: '',
  create: () => [],
  validate(c) {
    if (c.some((d) => !d.trim() || /[\s/]/.test(d.trim())))
      throw new Error('Write each site as a domain, e.g. example.com.');
  },
};

/** Absolute paths only (drive, UNC or POSIX root): a rule’s file cannot depend on the core’s working directory. */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
export type RuleFileFormat = 'jsonl' | 'markdown';
/**
 * File endings a file action may write, per format. Message text comes from other people, so a rule never writes a
 * file Windows would run or open as code (.cmd, .ps1, .html…).
 */
export const RULE_FILE_EXTENSIONS: Readonly<Record<RuleFileFormat, readonly string[]>> = {
  markdown: ['.md', '.markdown', '.txt'],
  jsonl: ['.jsonl', '.ndjson'],
};

/** Whether `path` ends in one of `format`'s file endings (any case). */
export const hasRuleFileExtension = (path: string, format: RuleFileFormat): boolean =>
  RULE_FILE_EXTENSIONS[format].some((ext) => path.trim().toLowerCase().endsWith(ext));

/** Appends each matching message to a supported local text file. */
export const file: RuleActionKind<FileConfig> = {
  ...AFTER_MESSAGE,
  type: 'file',
  label: 'Write to a file',
  hint: 'Appends the message to a file on this computer.',
  create: () => ({ path: '', format: 'markdown' }),
  validate(c) {
    if (!ABSOLUTE_PATH.test(c.path.trim())) throw new Error('Pick the file to write to.');
    if (!hasRuleFileExtension(c.path, c.format))
      throw new Error(`The file must end in ${RULE_FILE_EXTENSIONS[c.format].join(', ')} for this format.`);
  },
};

/** Runs a plugin command over the message lookback or scheduled window. */
export const command: RuleActionKind<CommandConfig> = {
  ...AFTER_MESSAGE,
  type: 'command',
  label: 'Run a plugin command',
  hint: 'Runs a plugin command over the channel before the message; at most once a minute per rule.',
  targets: ['message', 'window'],
  minIntervalMs: MS_PER_MIN,
  create: () => ({ pluginId: '', commandId: '', lookbackMs: MS_PER_HOUR }),
  validate(c) {
    if (!c.pluginId || !c.commandId) throw new Error('Pick the plugin command to run.');
    if (!(c.lookbackMs > 0)) throw new Error('Pick how far back the plugin command reaches.');
  },
};
