// A tab group's selection, kept by panel identity so panels appearing or leaving never shift it onto another tab.
import type { LayoutPanelId, PanelRef } from './types';

/** The shown tab of a tab group and the owner's pick. */
export interface TabSelection {
  /** The most recently picked panel the group lists, else its `initial` one, else the first listed; undefined for an empty group. Reactive. */
  shown: () => LayoutPanelId | undefined;
  pick: (id: LayoutPanelId) => void;
}

/** Tab picks across every group, most recent first; each group reads only its own panels from it. */
export interface TabPicks {
  recent: () => readonly LayoutPanelId[];
  pick: (id: LayoutPanelId) => void;
}

/** `panels` is the group's current (availability-filtered) list, read reactively. */
export function createTabSelection(panels: () => readonly PanelRef[], initial: number, picks: TabPicks): TabSelection {
  const shown = (): LayoutPanelId | undefined => {
    const list = panels();
    return picks.recent().find((id) => list.some((p) => p.id === id)) ?? (list[initial] ?? list[0])?.id;
  };
  return { shown, pick: picks.pick };
}
