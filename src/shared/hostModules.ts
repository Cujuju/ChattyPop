// The host's module namespaces that installed plugins' builds read instead of bundling (docs/plugin-architecture.md §16),
// on globalThis under HOST_MODULES_KEY. Each process's registries publish what that process provides before loading plugins.
import { HOST_MODULES_KEY, type HostModuleId } from './installedPlugins';

type HostModules = Partial<Record<HostModuleId, object>>;

/** The namespaces published in this process so far, by module id. */
export function hostModules(): HostModules {
  const g = globalThis as { [HOST_MODULES_KEY]?: HostModules };
  return (g[HOST_MODULES_KEY] ??= {});
}

/** Publishes `modules` (module id → its namespace) for installed plugins this process loads next. */
export function publishHostModules(modules: HostModules): void {
  Object.assign(hostModules(), modules);
}
