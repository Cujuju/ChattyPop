// Host panel identity and metadata, extended by bundled descriptors.
import type { HostPanelId } from '@shared/anchors';
import { bundledPanel } from '@shared/bundledPlugins';
import type { PanelImportance } from '@shared/bundledTypes';
import { isPluginPanelId } from '@shared/plugins';

/** Component-free built-in section title registry avoids import cycles. Bundled panel titles come from shared declarations. */
export const PANEL_TITLES = {
  channels: 'Channels',
  'sync-status': 'Sync',
  chat: 'Chat',
  'status-bar': 'Status',
} as const satisfies Record<HostPanelId, string>;

export type PanelId = keyof typeof PANEL_TITLES;

/** Header identity (colour and icon): a built-in panel, any folder plugin panel ('plugin'), or a bundled plugin's panel id. */
export type SectionId = PanelId | 'plugin' | (string & {});

/** The section (icon and theme colour) a panel wears: a folder plugin's panels all share 'plugin'. */
export const sectionOf = (id: string): SectionId => (isPluginPanelId(id) ? 'plugin' : id);

/** Panel identity includes section and individual id. Section drives icons/theme colors; id keys per-panel owner colors. */
export const panelIdentity = (id: string): { 'data-section': SectionId; 'data-panel-color': string } => ({ 'data-section': sectionOf(id), 'data-panel-color': id });

/** Theme-scoped importance distinguishes primary actions, secondary scanning and reference lookup. Frame panels keep base styling. */
export type { PanelImportance };

export const PANEL_IMPORTANCE: Partial<Record<PanelId, PanelImportance>> = {
  chat: 'reference',
};

export const panelImportance = (id: string): PanelImportance | undefined => (PANEL_IMPORTANCE as Record<string, PanelImportance>)[id] ?? bundledPanel(id)?.importance;

/** Frame panels (sidebar and status bar) stay put; the rest can swap places in a layout. */
export const MOVABLE_PANELS: ReadonlySet<PanelId> = new Set(['chat']);

/** Built-in panels no preset shows; added from a panel header's menu (Add … below). */
export const OPTIONAL_PANELS: readonly PanelId[] = [];
