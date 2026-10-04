// Section icons from host components and bundled panel paths.
import type { JSX } from 'solid-js';
import { bundledPanel } from '@shared/bundledPlugins';
import type { PanelId, SectionId } from '@/panels/titles';
import { ICON_SHAPES } from './icons';
import styles from './PanelHeader.module.css';

/** 24-unit line icon paths, one per section; each caller's CSS sets stroke and size (here PanelHeader.module.css). */
export const SECTION_ICON_PATHS: Record<PanelId | 'plugin' | 'settings', () => JSX.Element> = {
  // A Settings screen shown as a panel (the phone's): a gear.
  settings: ICON_SHAPES.settings,
  // Plugin panels: a plug.
  plugin: () => (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  channels: ICON_SHAPES.archive,
  'sync-status': () => (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8" />
      <path d="M20 20v-4.5h-4.5" />
    </>
  ),
  chat: ICON_SHAPES.conversation,
  'status-bar': () => <path d="M4 12h16" />,
};

/** The section's icon alone, without a tile; `class` sets its size and look (a top-bar button's icon). */
export function SectionGlyph(props: { section: SectionId; class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {(SECTION_ICON_PATHS as Partial<Record<string, () => JSX.Element>>)[props.section]?.() ?? <path d={bundledPanel(props.section)?.iconPath} />}
    </svg>
  );
}

/** The section's icon on its tinted tile; colour follows the nearest [data-section]. */
export function SectionIcon(props: { section: SectionId }) {
  return (
    <span class={styles.tile} aria-hidden="true">
      <SectionGlyph section={props.section} class={styles.icon} />
    </span>
  );
}
