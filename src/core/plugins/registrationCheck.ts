// What a bundled plugin's core side must register when it activates (docs/plugin-architecture.md §2): each core call
// it declares, its completion reports' handlers, its rule kinds, its AI providers and its search ranker.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { completionOf, membersOf } from '@shared/pluginChannels';
import type { RuleSection } from '@shared/ruleKinds/types';

/**
 * What was registered: a served core call, a completion report's handler, a rule kind in its section, an AI provider,
 * the search ranker.
 */
export type RegistrationKind = 'core call' | 'completion handler' | `rule ${RuleSection}` | 'AI provider' | 'search ranker';

/** A registration's key, as Registrations.registered records it. */
export const registration = (kind: RegistrationKind, name: string): string => `${kind} ${name}`;

/** The name a search ranker registers under: a plugin has at most one (descriptor `search.ranker`). */
export const SEARCH_RANKER = 'rerank';

/** Every registration `plugin`'s descriptor declares for its core side. */
export function declaredRegistrations(plugin: PluginDescriptor): string[] {
  const calls = membersOf(plugin.channels, 'core').map((name) => registration(completionOf(plugin.channels, name) ? 'completion handler' : 'core call', name));
  const kinds = Object.entries(plugin.rules ?? {}).flatMap(([section, list]) => list.map((kind) => registration(`rule ${section as RuleSection}`, kind.type)));
  const providers = (plugin.providers ?? []).map((p) => registration('AI provider', p.id));
  const ranker = plugin.search?.ranker ? [registration('search ranker', SEARCH_RANKER)] : [];
  return [...calls, ...kinds, ...providers, ...ranker];
}

/** Throws naming each registration `plugin` declares that `registered` lacks; an activation missing one failed. */
export function assertRegistered(plugin: PluginDescriptor, registered: ReadonlySet<string>): void {
  const missing = declaredRegistrations(plugin).filter((r) => !registered.has(r));
  if (missing.length) throw new Error(`${plugin.manifest.id} declares but never registered: ${missing.join(', ')}`);
}
