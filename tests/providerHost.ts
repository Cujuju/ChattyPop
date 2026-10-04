// Core init's order for AI provider tests: the registry, then bundled plugins activated over it.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { providerDeclarations } from '@shared/aiProviders';
import { normalizeAiSettings, type AiSettings } from '@shared/settings';
import type { DecisionProvider } from '../src/core/ai/decisions';
import { scopedCompletion } from '../src/core/ai/readScope';
import { ProviderRegistry } from '../src/core/ai/registry';
import { getSetting, setSetting, type Db } from '../src/core/db';
import type { CorePlugin } from '../src/core/plugins/context';
import { PluginHost } from '../src/core/plugins/host';
import { RuleKinds } from '../src/core/rules/kinds';
import { tempDb, tempDir } from './helpers';

/**
 * Starts `plugins` over a registry declaring `declared`'s providers. AI settings are read from `db` as core reads them
 * (normalized with the declarations). `jev` answers every Jev switch; `pluginsDir` holds folder plugins.
 */
export function startProviders(
  plugins: readonly CorePlugin[],
  declared: readonly PluginDescriptor[] = plugins.map((p) => p.plugin),
  db: Db = tempDb(),
  options: { jev?: DecisionProvider; pluginsDir?: string } = {},
) {
  const decls = providerDeclarations(declared);
  const registry = new ProviderRegistry(() => undefined, decls);
  const rules = new RuleKinds();
  const ai = (): AiSettings => normalizeAiSettings(getSetting(db, 'ai'), decls);
  const jev = (): DecisionProvider | null => options.jev ?? null;
  const host = new PluginHost(
    options.pluginsDir ?? tempDir(),
    {
      db,
      emit: () => undefined,
      changed: () => undefined,
      ai: scopedCompletion(() => db, registry, ai),
      decider: jev,
      bundled: {
        rules,
        ready: () => db,
        archive: () => null as never,
        mediaDir: tempDir(),
        attachmentsDir: tempDir(),
        pluginData: { root: tempDir(), unmoved: {} },
        storeText: () => undefined,
        storeLinkText: () => undefined, storeLinkImages: () => undefined,
        saveSetting: (key, value) => setSetting(db, key, value),
        aiSettings: ai,
        providers: registry,
        decider: jev,
        catchUp: () => undefined,
        now: Date.now,
      },
    },
    plugins,
  );
  host.startBundled();
  return { db, host, registry, ai, rules };
}
