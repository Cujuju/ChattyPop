// Plugin ownership and unavailable-kind explanations shared by core and renderer.
import { bundledPlugin } from './bundledPlugins';
import { HOST } from './ruleKinds/catalog';
import type { RuleSpec } from './rules';

/** A plugin as Settings → Plugins shows it: on, off, or failed to start with its error. */
export type PluginState = { status: 'active' } | { status: 'disabled' } | { status: 'error'; error: string | null };
/** Reads plugin `id`'s state now. */
export type PluginStates = (id: string) => PluginState;
/** A state from the on/off switch alone, for a reader that can't see activation (whoever sees it explains a failure). */
export const switchState = (on: boolean): PluginState => ({ status: on ? 'active' : 'disabled' });
/** States before the plugin host binds its own: no plugin has started. */
export const NONE_STARTED: PluginStates = () => switchState(false);

/** Owning plugin id, or null for a host kind, including kinds awaiting extraction. */
export function ruleKindPlugin(type: string): string | null {
  if (Object.values(HOST).some((kinds) => kinds.some((kind) => kind.type === type))) return null;
  return type.includes('.') ? type.split('.')[0]! : null;
}

/** Explains an absent, off or failed plugin; host kinds require no plugin. */
export function kindUnavailable(type: string, states: PluginStates): string | null {
  const id = ruleKindPlugin(type);
  return id ? needsPlugin(id, states) : null;
}

/** Why something plugin `id` provides can't be used: the plugin is absent from this build, off or failed; null while it runs. */
export function needsPlugin(id: string, states: PluginStates): string | null {
  const plugin = bundledPlugin(id);
  if (!plugin) return pluginAbsent(id);
  return pluginNotRunning(plugin.manifest.name, states(id));
}

/** Why the plugin named `name` in `state` can't provide anything; null while it is on. */
export function pluginNotRunning(name: string, state: PluginState): string | null {
  if (state.status === 'active') return null;
  return state.status === 'error' ? pluginFailed(name, state.error) : pluginOff(name);
}

/** Plugin `id` is not in this build. */
export const pluginAbsent = (id: string): string => `Needs the ${id} plugin, which this ChattyPop doesn't include.`;
/** The plugin named `name` is in this build but off. */
export const pluginOff = (name: string): string => `Needs the ${name} plugin, which is off.`;
/** The plugin named `name` is on but its activation threw `error`. */
export const pluginFailed = (name: string, error: string | null): string =>
  `Needs the ${name} plugin, which failed to start (see Settings → Plugins)${error ? `: ${error}` : '.'}`;

/** Unavailable conditions stop a rule; unavailable actions are skipped individually. */
export function ruleUnavailable(spec: RuleSpec, states: PluginStates): string | null {
  for (const part of [spec.trigger, ...spec.match, ...spec.narrow]) {
    const reason = kindUnavailable(part.type, states);
    if (reason) return reason;
  }
  return null;
}
