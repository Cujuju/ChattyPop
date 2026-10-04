// Rule templates from the host and active plugins.
import { For } from 'solid-js';
import { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
import { type HostRuleTemplateId } from '@shared/anchors';
import { RULE_SPEC_VERSION, type RuleAction, type RuleInput, type RuleMatch, type RuleNarrow, type RuleTrigger } from '@shared/rules';
import { newGates, newRuleAction } from '@shared/ruleSpec';
import { withPluginTemplates } from '@/plugins/slots';
import { editNewRule } from '@/state/rules';
import styles from './Rules.module.css';

const draft = (o: { trigger?: RuleTrigger; match?: RuleMatch; narrow?: RuleNarrow; actions: RuleAction[]; missed?: boolean }): RuleInput => ({
  name: '',
  enabled: true,
  discordSend: false,
  spec: {
    v: RULE_SPEC_VERSION,
    trigger: o.trigger ?? { type: MESSAGE_TRIGGER, config: null },
    gates: { ...newGates(), missed: o.missed ?? false },
    match: o.match ?? [],
    narrow: o.narrow ?? [],
    actions: o.actions,
  },
});

interface Template {
  /** A host template's id (HOST_RULE_TEMPLATES), or a plugin template's stamped id; plugins' placements name these. */
  id: string;
  title: string;
  /** What it matches → what it does, as pills. */
  flow: [string, string];
  hint: string;
  make: () => RuleInput;
}

const TEMPLATES: (Template & { id: HostRuleTemplateId })[] = [
  {
    id: 'links',
    title: 'Collect links',
    flow: ['Links', 'Save to file'],
    hint: 'Append matching links to a Markdown or JSON Lines file.',
    make: () =>
      draft({ narrow: [{ type: 'contains', config: ['link'] }], actions: [newRuleAction('file')], missed: true }),
  },

];

/** The built-in templates, each plugin template after the one it names. Reactive. */
function templates(): Template[] {
  return withPluginTemplates(TEMPLATES, (t): Template => ({
    id: t.id,
    title: t.title,
    flow: t.flow,
    hint: t.hint,
    make: () => draft(t.make()),
  }));
}

/** A new rule's starting points; each fills in the three steps, all changeable after. */
export function NewRule() {
  return (
    <div class={styles.newRule}>
      <h3 class={styles.newTitle}>What should this rule do?</h3>
      <p class={styles.meta}>
        Every choice can be changed after. Each fills in the three steps: when it runs, what matches, then what happens.
      </p>
      <div class={styles.templates}>
        <For each={templates()}>
          {(t) => (
            <button type="button" class={styles.template} onClick={() => editNewRule(t.make())}>
              <span class={styles.templateTitle}>{t.title}</span>
              <span class={styles.flow}>
                <span class={styles.pill} data-kind="match">
                  {t.flow[0]}
                </span>
                →<span class={styles.pill}>{t.flow[1]}</span>
              </span>
              <span class={styles.hint}>{t.hint}</span>
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class={`${styles.template} ${styles.blank}`}
        onClick={() => editNewRule(draft({ actions: [] }))}
      >
        <span class={styles.templateTitle}>Start blank</span>
        <span class={styles.hint}>Every message in every archived channel, no actions yet.</span>
      </button>
    </div>
  );
}
