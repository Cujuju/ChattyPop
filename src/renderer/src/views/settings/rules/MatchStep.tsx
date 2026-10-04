// Alternative matches and narrowing filters from host and plugin kinds.
import { For, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
import { type Rule, type RuleInput, type RuleSpec } from '@shared/rules';
import { ruleKind, ruleKinds } from '@shared/ruleKinds';
import { ruleKindPlugin } from '@shared/ruleAvailability';
import { PluginPart } from './PluginPart';
import { kindOffered } from '@/plugins/slots';
import { Field, Or, Step } from './fields';
import { ChipRow } from './pickers';
import { kindView, filterView } from './kinds';
import styles from './Rules.module.css';

/** If: any match part suffices, then every narrowing filter must hold. */
export function MatchStep(props: { input: RuleInput; rule: Rule | null; onSpec: (patch: Partial<RuleSpec>) => void }) {
  const spec = () => props.input.spec;
  const setPart = (section: 'match' | 'narrow', type: string, config: unknown): void => {
    const parts = spec()[section];
    const next =
      config === undefined
        ? parts.filter((p) => p.type !== type)
        : parts.some((p) => p.type === type)
          ? parts.map((p) => (p.type === type ? { type, config } : p))
          : [...parts, { type, config }];
    props.onSpec({ [section]: next });
  };
  const offered = () =>
    ruleKinds('match').filter(
      (k) =>
        (kindOffered(k.type) || spec().match.some((p) => p.type === k.type)) &&
        !kindView('match', k.type)?.managedOnly &&
        (!k.asksJev || spec().trigger.type === MESSAGE_TRIGGER) &&
        (!k.asksJev || !spec().match.some((p) => p.type !== k.type && ruleKind('match', p.type)?.asksJev)),
    );
  /** Each narrowing chip identifies its kind and selected entry for removal. */
  const chips = () =>
    spec().narrow.filter((p) => !ruleKindPlugin(p.type)).flatMap((p) =>
      (filterView(p.type)?.chips(p.config) ?? []).map((label, index) => ({ p, label, index })),
    );
  return (
    <Show when={props.rule?.builtin} fallback={<MatchFields />}>
      <Step title="If">
        <div class={styles.card}>
          <For each={spec().match}>
            {(p) => (
              <Dynamic
                component={kindView('match', p.type)?.Editor}
                id={`rule-${p.type}`}
                config={p.config}
                onChange={() => undefined}
              />
            )}
          </For>
        </div>
      </Step>
    </Show>
  );

  function MatchFields() {
    return (
      <Step title="If">
        <div class={styles.card}>
          <For each={spec().match.filter((part) => !ruleKind('match', part.type))}>
            {(part) => <Field label={part.type} hint="Its plugin isn't installed.">
              <button type="button" onClick={() => setPart('match', part.type, undefined)}>Remove match</button>
            </Field>}
          </For>
          <For each={offered()}>
            {(k, index) => (
              <>
                <Show when={index() > 0}>
                  <Or />
                </Show>
                <Field label={kindView('match', k.type)?.label?.() ?? k.label} for={`rule-${k.type}`} hint={k.hint}>
                  <Show when={ruleKindPlugin(k.type)} fallback={<Dynamic
                    component={kindView('match', k.type)?.Editor}
                    id={`rule-${k.type}`}
                    config={spec().match.find((p) => p.type === k.type)?.config}
                    spec={spec()}
                    onChange={(c: unknown) => setPart('match', k.type, c)}
                  />}>
                    <PluginPart
                      section="match"
                      kind={k}
                      part={spec().match.find((p) => p.type === k.type)}
                      onChange={(c) => setPart('match', k.type, c)}
                    />
                  </Show>
                </Field>
              </>
            )}
          </For>
          <Show when={!ruleKinds('match').some((k) => k.asksJev && offered().includes(k))}>
            <Field label="By meaning or Jev">
              <p class={styles.hint}>Needs a rule that starts on a message.</p>
            </Field>
          </Show>
          <Field
            label="And it has"
            tone="narrow"
            hint="Narrows the match, or matches alone."
          >
            <For each={spec().narrow.filter((part) => !ruleKind('filters', part.type))}>
              {(part) => <Field label={part.type} hint="Its plugin isn't installed.">
                <button type="button" onClick={() => setPart('narrow', part.type, undefined)}>Remove filter</button>
              </Field>}
            </For>
            <ChipRow
              items={chips()}
              label={(c) => c.label}
              onRemove={(c) => setPart('narrow', c.p.type, filterView(c.p.type)?.remove(c.p.config, c.index))}
            >
              <For each={ruleKinds('filters').filter((k) => kindOffered(k.type) || spec().narrow.some((p) => p.type === k.type))}>
                {(k) => (
                  <Show when={ruleKindPlugin(k.type)} fallback={<Dynamic
                    component={kindView('filters', k.type)?.Editor}
                    id={`rule-${k.type}`}
                    config={spec().narrow.find((p) => p.type === k.type)?.config ?? k.create()}
                    onChange={(c: unknown) => setPart('narrow', k.type, c)}
                  />}>
                    <PluginPart
                      section="filters"
                      kind={k}
                      part={spec().narrow.find((p) => p.type === k.type)}
                      onChange={(c) => setPart('narrow', k.type, c)}
                    />
                  </Show>
                )}
              </For>
            </ChipRow>
          </Field>
        </div>
      </Step>
    );
  }
}
