// Bundled plugins' main side (docs/plugin-architecture.md §5): starts each plugin's main side, hands core's plugin
// events for main to its listeners, and serves windows' plugin calls (the app's and remote desktops'), stamping them
// as a window's.
import { checkCallRequest } from '@shared/readPriority';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { MAIN_INVOKE } from '@shared/contract';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';
import { handleMain } from '../ipc/mainCalls';
import type { MainPlugin, MainPluginDeps } from './context';
import { startMainSides } from './sides';

/** A window's plugin call: the plugin, the member and its arguments, checked before they go anywhere. */
function checkCall(pluginId: unknown, name: unknown, args: unknown): [string, string, unknown[]] {
  if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId) || typeof name !== 'string' || !Array.isArray(args)) throw new Error('Bad plugin call.');
  return [pluginId, name, args as unknown[]];
}

/** Starts every bundled plugin's main side once, at startup (startMainSides), over IPC. Returns what stops the resources at quit. */
export function startMainPlugins(plugins: readonly MainPlugin[], d: MainPluginDeps): { stop(): Promise<void> } {
  const sides = startMainSides(plugins, d, BUNDLED_PLUGINS);
  d.states.onChange(() => {
    // Serve config a plugin set stays at quit for its next run; one now off or absent from this build is removed.
    void d.tailnet.reconcile((id) => d.states.active(id));
  });
  d.core.on('event', (e) => sides.deliver(e));
  handleMain(MAIN_INVOKE.plugins.callCore, (pluginId: unknown, name: unknown, args: unknown, request: unknown) => d.core.call('pluginCall', 'renderer', ...checkCall(pluginId, name, args), checkCallRequest(request)));
  handleMain(MAIN_INVOKE.plugins.cancelCore, (pluginId: unknown, id: unknown) => {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId) || typeof id !== 'string') throw new Error('Bad plugin cancel');
    return d.core.call('cancelPluginCall', 'renderer', pluginId, id);
  });
  handleMain(MAIN_INVOKE.plugins.callMain, (pluginId: unknown, name: unknown, args: unknown) => sides.callMain(...checkCall(pluginId, name, args)));
  return { stop: () => sides.stop() };
}
