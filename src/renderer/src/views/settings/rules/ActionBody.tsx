// Host and plugin action fields use the same kind view lookup.
import { Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { RuleAction } from '@shared/rules';
import { actionTypePlugin } from '@shared/bundledPlugins';
import { ruleKindPlugin } from '@shared/ruleAvailability';
import { kindOffered } from '@/plugins/slots';
import { Row } from '@/views/settings/SettingsLayout';
import { kindView } from './kinds';
import styles from './Rules.module.css';

/** One action’s own fields; step 3 adds, orders and removes actions. cover is a timed rule’s fixed range. */
export function ActionBody(props: { action: RuleAction; cover?: string; onChange: (a: RuleAction) => void }) {
  const ui = () => kindView('actions', props.action.type);
  const change = (config: unknown) => props.onChange({ ...props.action, config });
  return (
    <Show
      when={ui()}
      fallback={
        <Row
          label="Not available"
          hint={`Needs the ${actionTypePlugin(props.action.type)} plugin, which this ChattyPop doesn't include.`}
        />
      }
    >
      {(v) => (
        <Show when={ruleKindPlugin(props.action.type)} fallback={<Fields />}>
          <div class={styles.actionCards}>
            <Show when={!kindOffered(props.action.type)}>
              <Row
                label="Plugin off"
                hint="This action is skipped until its plugin is turned back on in Settings → Plugins."
              />
            </Show>
            <Fields />
          </div>
        </Show>
      )}
    </Show>
  );

  function Fields() {
    return <Dynamic
      component={ui()?.Editor}
      id={`rule-action-${props.action.id}`}
      config={props.action.config}
      cover={props.cover}
      onChange={change}
    />;
  }
}
