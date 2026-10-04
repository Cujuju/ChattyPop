// Compile-time probe: every declared kind needs its correctly typed renderer view.
import type { ComponentProps, JSX } from 'solid-js';
import type { Rule } from '@shared/rules';
import type { RuleTriggerKind, RuleMatchKind, RuleFilterKind, RuleActionKind } from '@shared/ruleKinds/types';
import type { RendererContributions } from './define';
import { defineRendererPlugin } from '@plugin-sdk/renderer';
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Probe = {
  manifest: {
    id: 'probe';
    name: 'Probe';
    version: '1';
    description: '';
  };
  rules: {
    triggers: readonly [RuleTriggerKind<string, 'probe.trigger'>];
    match: readonly [RuleMatchKind<number, 'probe.match'>];
    filters: readonly [RuleFilterKind<boolean, 'probe.filter'>];
    actions: readonly [RuleActionKind<{
      text: string;
    }, 'probe.action'>];
  };
};
type Views = NonNullable<RendererContributions<Probe>['rules']>;
type MissingRulesFails = Assert<Equal<{} extends RendererContributions<Probe> ? true : false, false>>;
type MissingTriggerFails = Assert<Equal<Omit<Views, 'triggers'> extends Views ? true : false, false>>;
type MissingMatchFails = Assert<Equal<Omit<Views, 'match'> extends Views ? true : false, false>>;
type MissingFilterFails = Assert<Equal<Omit<Views, 'filters'> extends Views ? true : false, false>>;
type MissingActionFails = Assert<Equal<Omit<Views, 'actions'> extends Views ? true : false, false>>;
type MissingChipsFails = Assert<Equal<Omit<Views['filters']['probe.filter'], 'chips'> extends Views['filters']['probe.filter'] ? true : false, false>>;
type Config = Assert<Equal<ComponentProps<Views['actions']['probe.action']['Editor']>['config'], {
  text: string;
}>>;
type Change = Assert<Equal<Parameters<ComponentProps<Views['match']['probe.match']['Editor']>['onChange']>[0], number>>;
type BadgeInput = Assert<Equal<Parameters<NonNullable<Views['ruleBadge']>>[0], Rule>>;
type BadgeOutput = Assert<Equal<ReturnType<NonNullable<Views['ruleBadge']>>, JSX.Element | null>>;

function checkDefinition(plugin: Probe): void {
  // @ts-expect-error The definition helper cannot widen away declared rule views.
  defineRendererPlugin(plugin, {});
  // @ts-expect-error All four declared sections are required.
  defineRendererPlugin(plugin, { rules: {} });
}
