// Compile-time SDK contracts for scoped names, configuration and action phases.
import type { CoreContext } from '@plugin-sdk/core';
import { defineRuleFilter } from '@plugin-sdk/shared';
import { probe } from './pluginRuleDescriptor';

function checkContext(ctx: CoreContext<typeof probe>): void {
  // @ts-expect-error Match-phase actions cannot return promises.
  ctx.rules.action('ruleprobe.instant', async () => ({ outcome: 'done', detail: null }));
  // @ts-expect-error The plugin cannot register a host-owned kind.
  ctx.rules.match('text', { direct: () => null });
  // @ts-expect-error The filter's declared configuration is numeric.
  ctx.rules.filter('ruleprobe.filter', { prepare: (config: string) => config, test: () => true });
  // @ts-expect-error The trigger's declared configuration is text.
  ctx.rules.trigger('ruleprobe.start').fire({ m: null as never, liveAt: null, key: '', accepts: (c: number) => c > 0 });
}

function checkDeclaration(): void {
  defineRuleFilter({
    type: 'probe.config',
    label: '',
    hint: '',
    create: () => 1,
    // @ts-expect-error The validator must accept the configuration produced by create.
    validate: (config: string) => { config.toLowerCase(); },
  });
}
