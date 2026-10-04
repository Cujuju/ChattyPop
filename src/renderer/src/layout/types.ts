import type { PluginPanelId } from '@shared/plugins';
import type { PanelId } from '../panels/titles';

/** A built-in panel, a folder plugin's (plugin:<plugin id>:<panel id>), or a bundled plugin's (@shared/bundledPlugins bundledPanel). */
export type LayoutPanelId = PanelId | PluginPanelId | (string & {});

/** A size share within a split: a flex fraction, or 'auto' to size to the panel's content. */
export type SplitSize = number | 'auto';

export type LayoutNode =
  | { kind: 'split'; dir: 'row' | 'column'; sizes: SplitSize[]; children: LayoutNode[] }
  | { kind: 'tabs'; active: number; children: PanelRef[] }
  | PanelRef;

export interface PanelRef {
  kind: 'panel';
  id: LayoutPanelId;
}

/** Persisted layout document. Bump `version` when the node shape changes. */
export interface LayoutDoc {
  version: 1;
  name: string;
  root: LayoutNode;
}
