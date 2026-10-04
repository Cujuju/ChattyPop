// The late-bound accessor host modules read bundled plugins' renderer sides through (docs/plugin-architecture.md §9).
// The registry (./bundled) installs the build's entries; host modules never import it, so no host or SDK module
// depends on the plugins that depend on them, and the order an entry imports them in can't break either.
import { checkSlotViews, type SlotViewsOf } from '@shared/slots';
import type { RendererPlugin } from './define';

let installed: readonly RendererPlugin[] | null = null;
let markInstalled: () => void = () => undefined;
const installing = new Promise<void>((resolve) => (markInstalled = resolve));

/** Installs the build's renderer entries. Once per page, from the registry. Throws on an entry missing a declared slot item's view. */
export function installRendererPlugins(entries: readonly RendererPlugin[]): void {
  if (installed) throw new Error('The renderer plugins are already installed.');
  for (const entry of entries) checkSlotViews(entry.plugin.manifest.id, entry.plugin.slots, entry.contributions as SlotViewsOf);
  installed = entries;
  markInstalled();
}

/**
 * Resolves once the registry installs the entries. The registry awaits installed plugins (top-level await), so a page
 * entry loaded beside it, not through it (a plugin page after the bootstrap), waits on this before it renders.
 */
export const rendererPluginsInstalled = (): Promise<void> => installing;

/** The installed entries. Throws before the registry installs them: a slot read that early is a startup-order bug. */
export function rendererPlugins(): readonly RendererPlugin[] {
  if (!installed) throw new Error('A plugin slot was read before the plugin registry installed the renderer plugins.');
  return installed;
}
