// Default layouts with declared plugin panels inserted at preset anchors.
import { bundledPanels } from '@shared/bundledPlugins';
import type { PanelDecl } from '@shared/bundledTypes';
import { placePresetPanels } from './presetPanels';
import { collapseSingles } from './tree';
import { projectLayout } from './visibility';
import { PANEL_TITLES } from '../panels/titles';
import type { LayoutDoc, LayoutNode, LayoutPanelId, PanelRef, SplitSize } from './types';

/** Presets include built-in and bundled panels. Unavailable plugin panels collapse out; tests validate ids against possible build panels. */
const panel = (id: LayoutPanelId): PanelRef => ({ kind: 'panel', id });
const row = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'row', sizes, children });
const col = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'column', sizes, children });

/** Sidebar column shared by every preset: channels fill, sync status pinned at the bottom (F2). */
const sidebar = col([1, 'auto'], panel('channels'), panel('sync-status'));
// Split fractions below reproduce F2's proportions (sidebar ≈ 1/6, insight ≈ 2/5 of height).
const SIDEBAR_SHARE = 1;
const WORKSPACE_SHARE = 5;

const insightRow = row([3, 2, 2], col(['auto'], panel('provider')), panel('alerts'), panel('links'));

const HOST_PRESETS: Record<'stacked' | 'side-by-side' | 'tabbed', LayoutDoc> = {
  stacked: {
    version: 1,
    name: 'Stack',
    root: col([1, 'auto'], row([SIDEBAR_SHARE, WORKSPACE_SHARE], sidebar, col([2, 3], insightRow, panel('chat'))), panel('status-bar')),
  },
  'side-by-side': {
    version: 1,
    name: 'Side',
    root: col(
      [1, 'auto'],
      row(
        [SIDEBAR_SHARE, 2, 3],
        sidebar,
        col(['auto', 2, 2], panel('provider'), panel('alerts'), panel('links')),
        panel('chat'),
      ),
      panel('status-bar'),
    ),
  },
  tabbed: {
    version: 1,
    name: 'Tabs',
    root: col(
      [1, 'auto'],
      row([SIDEBAR_SHARE, WORKSPACE_SHARE], sidebar, {
        kind: 'tabs',
        active: 0,
        children: [panel('chat'), panel('links'), panel('alerts'), panel('provider')],
      }),
      panel('status-bar'),
    ),
  },
};

export type PresetId = keyof typeof HOST_PRESETS;

/** Presets keep declared plugin positions; build-excluded anchors disappear after placement. Runtime visibility never changes these trees. */
export function buildPresets(panels: readonly PanelDecl[]): Record<PresetId, LayoutDoc> {
  const available = new Set([...Object.keys(PANEL_TITLES), ...panels.map((p) => p.id)]);
  return Object.fromEntries(Object.entries(HOST_PRESETS).map(([id, doc]) => [id, {
    ...doc,
    root: projectLayout(collapseSingles(placePresetPanels(doc.root, id, panels)), (panel) => !available.has(panel)).root!,
  }])) as Record<PresetId, LayoutDoc>;
}

/** Layouts for the panels included in this build. */
export const PRESETS = buildPresets(bundledPanels());
