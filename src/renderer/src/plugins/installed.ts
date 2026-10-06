// Late-bound renderer registry access avoids host/SDK dependency cycles. Bundled registry installs entries without host modules importing plugin definitions.
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

/** Resolves after registry installation, including awaited installed plugins. Independently loaded page entries wait before rendering. */
export const rendererPluginsInstalled = (): Promise<void> => installing;

/** The installed entries. Throws before the registry installs them: a slot read that early is a startup-order bug. */
export function rendererPlugins(): readonly RendererPlugin[] {
  if (!installed) throw new Error('A plugin slot was read before the plugin registry installed the renderer plugins.');
  return installed;
}
