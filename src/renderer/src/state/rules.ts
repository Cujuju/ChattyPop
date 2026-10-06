// Rule editing, run history and managed switches supplied by active plugins.
import { api } from '@/api';
import type { ContentKind } from '@shared/messageContent';
import type { PatternPreview } from '@shared/keywordPattern';
import { createResource, createSignal, onCleanup } from 'solid-js';
import { unwrap } from 'solid-js/store';
import type { PersonMatch } from '@shared/contract';
import { type Rule, type RuleInput, type RuleRun } from '@shared/rules';
import type { RuleFileFormat } from '@shared/ruleKinds/host';
import { newRuleInput } from '@shared/ruleSpec';
import { onAppEvent } from './events';
import { managedControl } from './managedControls';
import { keyedById } from './paged';
import { openSettingsAt } from './ui';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { textOrNull } from '@shared/normalize';

/** The rule list's filter text, restored on start. */
export const [rulesFilter, setRulesFilter] = createSetting<string>(SETTINGS_KEYS.rulesFilter, '', (v) => textOrNull(v, false) ?? '');

/** Runs listed under the open rule. */
const RUN_PAGE_SIZE = 50;
/** Settings' tab id for the Rules page. */
export const RULES_SECTION = 'rules';
const core = api.core;

export const [rules, { refetch: refetchRules }] = createResource<Rule[]>(() => core.rules(), {
  initialValue: [],
  storage: keyedById,
});

/** The Rules page's open page: a rule id, 'new' (picking what a new rule starts as), 'draft' (editing it), or null for none. */
export type RulePage = number | 'new' | 'draft' | null;
const [openRuleId, setOpenPage] = createSignal<RulePage>(null);
export { openRuleId };

/** Whether the open page may be left; the open editor asks about unsaved edits. */
let mayLeave = (): boolean => true;
/** Registers the open editor's leave check for as long as the calling component lives. */
export function guardRulePage(check: () => boolean): void {
  mayLeave = check;
  onCleanup(() => {
    if (mayLeave === check) mayLeave = () => true;
  });
}

/** Whether the open rule page may be left (Settings switching tab or closing); asks about unsaved edits. */
export const mayLeaveRulePage = (): boolean => mayLeave();

/** Opens a page of Settings → Rules unless the open editor keeps it; false when it stays. */
export function setOpenRuleId(page: RulePage): boolean {
  if (page === openRuleId()) return true;
  if (!mayLeave()) return false;
  setOpenPage(page);
  return true;
}

/** What a new rule starts as (the template picked). */
export const [newRuleDraft, setNewRuleDraft] = createSignal<RuleInput>(newRuleInput());

export const [ruleRuns, { refetch: refetchRuns }] = createResource(
  () => {
    const id = openRuleId();
    return typeof id === 'number' ? id : null;
  },
  (id): Promise<RuleRun[]> => core.ruleRuns(id, RUN_PAGE_SIZE),
  { initialValue: [] },
);

const refetchAll = (): void => {
  void refetchRules();
  if (typeof openRuleId() === 'number') void refetchRuns();
};
onAppEvent('rules-changed', refetchAll);
onAppEvent('privacy-changed', refetchAll);

/** Adds a rule and opens it; throws with a message for the editor. */
export async function createRule(input: RuleInput): Promise<void> {
  const id = await core.createRule(input);
  await refetchRules();
  setOpenPage(id); // the draft is saved; nothing to lose
}

export async function saveRule(id: number, input: RuleInput): Promise<void> {
  await core.updateRule(id, input);
  await refetchRules();
}

export async function deleteRule(id: number): Promise<void> {
  await core.deleteRule(id);
  if (openRuleId() === id) setOpenPage(null);
  await refetchRules();
}

/** A rule's editable fields as a plain copy, detached from the rules store. */
export function ruleInputOf(r: Rule): RuleInput {
  const { name, enabled, discordSend, spec } = unwrap(r);
  return structuredClone({ name, enabled, discordSend, spec });
}

/** Re-enabling rules re-arms them. Built-in switches toggle owning Jev features, which core synchronizes back to rules. */
export async function setRuleEnabled(r: Rule, enabled: boolean): Promise<void> {
  const control = managedControl(r);
  if (control) return control.setEnabled(enabled);
  if (r.builtin) return;
  await saveRule(r.id, { ...ruleInputOf(r), enabled });
}

/** A built-in rule can't be turned on while Jev isn't set up (it asks Jev about each message). */
export const ruleSwitchLocked = (r: Rule): boolean =>
  managedControl(r)?.locked() ?? Boolean(r.builtin);

/** People matching a typed name, for a rule's Who. */
export const findPeople = (query: string, limit: number): Promise<PersonMatch[]> => core.findPeople(query, limit);
/** Names for the people a rule already lists. */
export const peopleByIds = (ids: string[]): Promise<PersonMatch[]> => core.peopleByIds(ids);
/** Asks for the file a file action appends to; null when cancelled. */
export const pickRuleFile = (format: RuleFileFormat): Promise<string | null> => api.rules.pickFile(format);

/** Shows a rule's editor in Settings → Rules. */
export function openRule(id: number): void {
  if (setOpenRuleId(id)) openSettingsAt(RULES_SECTION);
}

/** Shows the new-rule starting points in Settings → Rules. */
export function startNewRule(): void {
  if (setOpenRuleId('new')) openSettingsAt(RULES_SECTION);
}

/** Opens a new rule's editor, starting from `draft` (a starting point's). */
export function editNewRule(draft: RuleInput = newRuleInput()): void {
  setNewRuleDraft(draft); // before the page opens: the editor starts from it
  setOpenRuleId('draft');
}

/** Previews recent keyword matches in selected channels; null means all. */
export const patternPreview = (pattern: string, channelIds: string[] | null, contains: ContentKind[] | null): Promise<PatternPreview> =>
  core.patternPreview(pattern, channelIds, contains);
