// Host panel identity and metadata, extended by bundled descriptors.
import type { HostPanelId } from '@shared/anchors';
import { bundledPanel } from '@shared/bundledPlugins';
import type { PanelImportance } from '@shared/bundledTypes';
import { isPluginPanelId } from '@shared/plugins';

/**
 * Every built-in named section of the UI and its title. Component-free, so any module (headers, menus) can import it
 * without a cycle. Bundled plugins' panels are declared in their shared entries (bundledPanel).
 */
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

/**
 * What every element carrying a panel's identity sets: its section (icon, theme colour) and its own id, which the
 * owner's panel colour keys on (theme/panelColors.ts), so panels sharing a section are coloured one by one.
 */
export const panelIdentity = (id: string): { 'data-section': SectionId; 'data-panel-color': string } => ({ 'data-section': sectionOf(id), 'data-panel-color': id });

/**
 * How much a panel stands out; each theme decides how (tokens scoped to [data-importance]). Primary: act on it;
 * secondary: scan it; reference: look up when needed. Frame panels have none and keep the base look.
 */
export type { PanelImportance };

export const PANEL_IMPORTANCE: Partial<Record<PanelId, PanelImportance>> = {
  chat: 'reference',
};

export const panelImportance = (id: string): PanelImportance | undefined => (PANEL_IMPORTANCE as Record<string, PanelImportance>)[id] ?? bundledPanel(id)?.importance;

/** Frame panels (sidebar and status bar) stay put; the rest can swap places in a layout. */
export const MOVABLE_PANELS: ReadonlySet<PanelId> = new Set(['chat']);

/** Built-in panels no preset shows; added from a panel header's menu (Add … below). */
export const OPTIONAL_PANELS: readonly PanelId[] = [];
