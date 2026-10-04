// Rule list, plugin badges and the selected rule editor.
import { ruleBadges } from '@/plugins/slots';
import { For, Match, Show, Switch as Branch } from 'solid-js';
import type { Rule } from '@shared/rules';
import { openRuleId, rules, rulesFilter as filter, setOpenRuleId, setRuleEnabled, setRulesFilter as setFilter, startNewRule } from '@/state/rules';
import { createAction } from '@/ui/action';
import { countText } from '@/ui/format';
import { Select } from '@/ui/Select';
import { Page } from '../SettingsLayout';
import { RuleSwitch } from './fields';
import { NewRule } from './NewRule';
import { RuleEditor } from './RuleEditor';
import { ruleLine } from './summaries';
import styles from './Rules.module.css';

/** Picker values for the new-rule pages (narrow windows). */
const NEW = 'new';
const DRAFT = 'draft';

/** One rule in the list: name, what it matches → does, unread alerts, and its switch. */
function RuleItem(props: { rule: Rule; current: boolean; onToggle: (on: boolean) => void }) {
  const r = () => props.rule;
  return (
    <li class={styles.item} data-current={props.current} data-off={!r().enabled} data-error={!!r().error}>
      <button type="button" class={styles.itemButton} aria-current={props.current || undefined} title={r().error ?? undefined} onClick={() => setOpenRuleId(r().id)}>
        <span class={styles.itemName}>{r().name}</span>
        <span class={styles.itemLine}>{r().error ? "Can't run" : ruleLine(r())}</span>
      </button>
      {ruleBadges(r())}
      <RuleSwitch rule={r()} checked={r().enabled} onChange={props.onToggle} />
    </li>
  );
}

/**
 * Settings → Rules: the rule list (yours, then built in) with a filter and each rule's switch, and beside
 * it the open rule as one page. Narrow windows get a rule picker instead of the list.
 */
export function RulesSection() {
  const toggling = createAction();
  const current = (): number | typeof NEW | typeof DRAFT | null => {
    const id = openRuleId();
    return id === NEW || id === DRAFT ? id : (rules().find((r) => r.id === id)?.id ?? null);
  };
  /** Yours or built in, by name. */
  const sorted = (builtin: boolean): Rule[] =>
    rules().filter((r) => !!r.builtin === builtin).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const shown = (builtin: boolean): Rule[] => {
    const words = filter().toLowerCase().split(/\s+/).filter(Boolean);
    return sorted(builtin).filter((r) => words.every((w) => `${r.name} ${ruleLine(r)}`.toLowerCase().includes(w)));
  };
  const builtins = (): number => rules().filter((r) => r.builtin).length;
  const toggle = (r: Rule, on: boolean): void => void toggling.run(() => setRuleEnabled(r, on));
  const group = (label: string, items: () => Rule[]) => (
    <Show when={items().length}>
      <li class={styles.group}>{label}</li>
      <For each={items()}>{(r) => <RuleItem rule={r} current={current() === r.id} onToggle={(on) => toggle(r, on)} />}</For>
    </Show>
  );

  return (
    <Page
      id="rules"
      title="Rules"
      lede={[countText(rules().length, 'rule'), builtins() ? `${builtins()} built in` : null].filter(Boolean).join(' · ')}
      right={
        <button type="button" class="cp-primary" disabled={current() === NEW} onClick={() => startNewRule()}>
          + New rule
        </button>
      }
    >
      <div class={styles.body} data-section="rules">
        <div class={styles.layout}>
          <nav class={styles.rail} aria-label="Rules">
            <input class={styles.filter} type="search" placeholder="Filter rules" aria-label="Filter rules" value={filter()} onInput={(e) => void setFilter(e.currentTarget.value)} />
            <ul class={styles.list}>
              <Show when={current() === NEW || current() === DRAFT}>
                <li class={styles.group}>New</li>
                <li class={styles.item} data-current="true">
                  <span class={styles.itemButton}>
                    <span class={styles.itemName}>New rule</span>
                    <span class={styles.itemLine}>{current() === NEW ? 'Pick a starting point' : 'Not saved yet'}</span>
                  </span>
                </li>
              </Show>
              {group('Your rules', () => shown(false))}
              {group('Built in', () => shown(true))}
            </ul>
            <Show when={toggling.error()}>
              <p class={`cp-note cp-note-error ${styles.listError}`} role="alert">
                {toggling.error()}
              </p>
            </Show>
          </nav>
          <div class={styles.picker}>
            <Select
              value={String(current() ?? '')}
              label="Rule"
              options={[
                { value: '', label: 'Pick a rule' },
                ...(current() === NEW || current() === DRAFT ? [{ value: String(current()), label: 'New rule' }] : []),
                ...[...sorted(false), ...sorted(true)].map((r) => ({ value: String(r.id), label: r.name })),
              ]}
              onChange={(v) => setOpenRuleId(v === NEW || v === DRAFT ? v : v ? Number(v) : null)}
            />
          </div>
          {/* Keyed on the rule: refreshed run counts must not remount the page and drop unsaved edits. */}
          <Branch fallback={<p class={styles.empty}>{rules().length ? 'Pick a rule to edit it, or add one.' : 'Add a rule to act on messages: alert, tag, post and more.'}</p>}>
            <Match when={current() === NEW}>
              <NewRule />
            </Match>
            <Match when={current() === DRAFT}>
              <RuleEditor ruleId={null} onClose={() => setOpenRuleId(null)} />
            </Match>
            <Match when={typeof current() === 'number' && current()} keyed>
              {(id) => <RuleEditor ruleId={id as number} onClose={() => setOpenRuleId(null)} />}
            </Match>
          </Branch>
        </div>
      </div>
    </Page>
  );
}
