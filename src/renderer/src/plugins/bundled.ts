// The build's plugin registry (docs/plugin-architecture.md §9): loads every bundled plugin's renderer side and installs
// them for the host's slots. Only page entries import it (main.tsx, ./page.ts); plugins and the SDK never do.
import entries from 'virtual:bundled-plugins/renderer';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { checkSlotViews } from '@shared/slots';
import { installRendererPlugins } from './installed';
import { installedShared } from './installedShared';
// The slot readers bind the host's late registries (unread counts, managed-rule controls) as they load.
import './slots';

// A plugin with no renderer side has no views, so it may declare no slot items. The installed plugins' loader checked
// theirs, leaving out one that failed (§16).
const rendered = new Set(entries.map((entry) => entry.plugin.manifest.id));
const installed = new Set((await installedShared()).map((p) => p.manifest.id));
for (const p of BUNDLED_PLUGINS) if (!rendered.has(p.manifest.id) && !installed.has(p.manifest.id)) checkSlotViews(p.manifest.id, p.slots, {});
installRendererPlugins(entries);
