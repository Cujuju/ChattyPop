import { describe, expect, it } from 'vitest';
import { bakeSizes, contentSized, dropZoneAt, insertBelow, isLayoutNode, movePanel, nextShare, normalizeShares, panelIds, removePanel, resizeShares, retirePanel, swapPanels } from '../src/renderer/src/layout/tree';
import type { LayoutNode, PanelRef, SplitSize } from '../src/renderer/src/layout/types';

const panel = (id: string) => ({ kind: 'panel', id }) as LayoutNode;
const root: LayoutNode = {
  kind: 'split',
  dir: 'row',
  sizes: [1, 'auto'],
  children: [panel('summary'), { kind: 'split', dir: 'column', sizes: [2, 1], children: [panel('links'), panel('chat')] }],
};

describe('layout tree edits', () => {
  it('shows a retired panel as the one it became, or drops it when that one is already there or it became none', () => {
    const withTopics: LayoutNode = { ...root, children: [panel('topics'), (root as { children: LayoutNode[] }).children[1]!] } as LayoutNode;
    expect(panelIds(retirePanel(withTopics, 'topics', 'tags')!)).toEqual(['tags', 'links', 'chat']);
    expect(panelIds(retirePanel(withTopics, 'topics', 'links')!)).toEqual(['links', 'chat']);
    expect(panelIds(retirePanel(withTopics, 'topics', null)!)).toEqual(['links', 'chat']);
    expect(retirePanel(root, 'topics', null)).toBe(root);
  });

  it('swaps two panels and keeps the structure', () => {
    const r = swapPanels(root, 'summary', 'chat');
    expect(panelIds(r)).toEqual(['chat', 'links', 'summary']);
    expect(isLayoutNode(r)).toBe(true);
  });

  it('adds a panel below another, sharing its height', () => {
    const r = insertBelow(root, 'links', 'plugin:demo:notes');
    expect(panelIds(r)).toEqual(['summary', 'links', 'plugin:demo:notes', 'chat']);
    expect(isLayoutNode(r)).toBe(true);
  });

  it('removes a panel and collapses a split left with one child', () => {
    const added = insertBelow(root, 'links', 'plugin:demo:notes');
    expect(removePanel(added, 'plugin:demo:notes')).toEqual(root);
    const r = removePanel(root, 'chat')!;
    expect(r).toEqual({ kind: 'split', dir: 'row', sizes: [1, 'auto'], children: [panel('summary'), panel('links')] });
    expect(removePanel(panel('summary'), 'summary')).toBeNull();
  });
});

describe('plugin panel ids', () => {
  it('recognises plugin:<plugin>:<panel> and nothing else', async () => {
    const { isPluginPanelId, pluginPanelId } = await import('@shared/plugins');
    expect(isPluginPanelId(pluginPanelId('example-activity', 'activity'))).toBe(true);
    expect(isPluginPanelId('plugin:example-activity:top_posters-2')).toBe(true);
    expect(isPluginPanelId('summary')).toBe(false);
    expect(isPluginPanelId('plugin:Bad Id:x')).toBe(false);
  });
});

describe('docking a panel beside another', () => {
  // An insight row: provider/summary column, tags/alerts column, links.
  const insight: LayoutNode = {
    kind: 'split',
    dir: 'row',
    sizes: [3, 2, 2],
    children: [
      { kind: 'split', dir: 'column', sizes: ['auto', 1], children: [panel('provider'), panel('summary')] },
      { kind: 'split', dir: 'column', sizes: [1, 1], children: [panel('tags'), panel('alerts')] },
      panel('links'),
    ],
  };

  it('puts tags beside alerts: the emptied column collapses and they share its width', () => {
    const r = movePanel(insight, 'tags', 'alerts', 'right');
    expect(r).toEqual({ ...insight, sizes: [3, 1, 1, 2], children: [insight.children[0], panel('alerts'), panel('tags'), panel('links')] });
    expect(isLayoutNode(r)).toBe(true);
  });

  it('wraps the target in a new split across the parent axis, keeping its share', () => {
    const r = movePanel(insight, 'links', 'summary', 'left');
    expect(r.kind === 'split' && r.children[0]).toEqual({
      kind: 'split',
      dir: 'column',
      sizes: ['auto', 1],
      children: [panel('provider'), { kind: 'split', dir: 'row', sizes: [1, 1], children: [panel('links'), panel('summary')] }],
    });
    expect(panelIds(r)).toEqual(['provider', 'links', 'summary', 'tags', 'alerts']);
  });

  it('gives a panel docked by a content-sized one the mean share, and makes a wrapped content-sized slot fill', () => {
    const below = movePanel(insight, 'links', 'provider', 'bottom');
    expect(below.kind === 'split' && below.children[0]).toMatchObject({ sizes: ['auto', 1, 1], children: [panel('provider'), panel('links'), panel('summary')] });
    const beside = movePanel(insight, 'links', 'provider', 'right');
    expect(beside.kind === 'split' && beside.children[0]).toMatchObject({ sizes: [1, 1] });
  });

  it('is a no-op for the same panel or a missing target', () => {
    expect(movePanel(insight, 'tags', 'tags', 'left')).toBe(insight);
    expect(movePanel(insight, 'tags', 'chat', 'left')).toBe(insight);
  });

  it('adds a panel that is not in the layout (dragged from the toolbar)', () => {
    const r = movePanel(insight, 'plans', 'links', 'bottom');
    expect(r).toEqual({ ...insight, children: [insight.children[0], insight.children[1], { kind: 'split', dir: 'column', sizes: [1, 1], children: [panel('links'), panel('plans')] }] });
    expect(isLayoutNode(r)).toBe(true);
  });

  it('replaces the target when swapping in a panel that is not in the layout', () => {
    expect(panelIds(swapPanels(insight, 'plans', 'links'))).toEqual(['provider', 'summary', 'tags', 'alerts', 'plans']);
  });

  it('docks beside a tab group, not inside it', () => {
    const tabs: LayoutNode = { kind: 'tabs', active: 0, children: [panel('summary') as PanelRef, panel('chat') as PanelRef, panel('links') as PanelRef] };
    const r = movePanel(tabs, 'links', 'chat', 'bottom');
    expect(r).toEqual({ kind: 'split', dir: 'column', sizes: [1, 1], children: [{ ...tabs, children: [panel('summary'), panel('chat')] }, panel('links')] });
  });

  it('splits the sidebar column below Channels, above the pinned sync status', () => {
    const sidebar: LayoutNode = { kind: 'split', dir: 'column', sizes: [1, 'auto'], children: [panel('channels'), panel('sync-status')] };
    const layout: LayoutNode = { kind: 'split', dir: 'row', sizes: [1, 5], children: [sidebar, panel('links')] };
    const r = movePanel(layout, 'links', 'channels', 'bottom');
    expect(r).toEqual({ kind: 'split', dir: 'column', sizes: [0.5, 0.5, 'auto'], children: [panel('channels'), panel('links'), panel('sync-status')] });
  });
});

describe('choosing a drop zone', () => {
  const every = ['left', 'right', 'top', 'bottom', 'center'] as const;

  it('docks on an edge band and swaps in the middle when the target takes every zone', () => {
    expect(dropZoneAt(every, 0.1, 0.5)).toBe('left');
    expect(dropZoneAt(every, 0.5, 0.9)).toBe('bottom');
    expect(dropZoneAt(every, 0.5, 0.5)).toBe('center');
  });

  it('snaps to the nearest allowed edge when the middle takes no drop', () => {
    expect(dropZoneAt(['top', 'bottom'], 0.05, 0.4)).toBe('top');
    expect(dropZoneAt(['top', 'bottom'], 0.5, 0.6)).toBe('bottom');
    expect(dropZoneAt([], 0.5, 0.5)).toBeNull();
  });
});

describe('baking saved split sizes', () => {
  it('writes saved fractions into numeric sizes by path and ignores a stale count', () => {
    const r = bakeSizes(root, { '': [4], '1': [3, 5] });
    expect(r).toEqual({ ...root, sizes: [4, 'auto'], children: [panel('summary'), { ...(root as { children: LayoutNode[] }).children[1], sizes: [3, 5] }] });
    expect(bakeSizes(root, { '1': [3] })).toEqual(root);
  });
});

describe('drawn split sizes', () => {
  const folded = (...ids: string[]) => (id: string) => ids.includes(id);
  const col = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'column', sizes, children });
  const row = (sizes: SplitSize[], ...children: LayoutNode[]): LayoutNode => ({ kind: 'split', dir: 'row', sizes, children });

  it('folds a column of only folded or auto panels to content height, but not while one is open', () => {
    const c = col(['auto', 1], panel('provider'), panel('summary'));
    expect(contentSized(c, 'column', folded('summary'))).toBe(true);
    expect(contentSized(c, 'column', folded())).toBe(false);
    expect(contentSized(c, 'row', folded('summary'))).toBe(false); // folding is vertical only
  });

  it('folds a row by height only when every child folds, nested splits included', () => {
    const r = row([1, 1], col([1, 1], panel('topics'), panel('alerts')), panel('links'));
    expect(contentSized(r, 'column', folded('topics', 'alerts', 'links'))).toBe(true);
    expect(contentSized(r, 'column', folded('topics', 'links'))).toBe(false);
    // In a row, 'auto' is a width: it doesn't make a child's height content-sized.
    expect(contentSized(row([1, 'auto'], panel('links'), panel('chat')), 'column', folded('links'))).toBe(false);
  });

  it('rescales shares to sum to 1 so the remaining shares fill the split', () => {
    expect(normalizeShares([0.8, 'auto', 'auto'])).toEqual([1, 'auto', 'auto']);
    expect(normalizeShares([1, 3, 'auto'])).toEqual([0.25, 0.75, 'auto']);
  });

  it('pairs a handle with the next share-sized child across folded ones', () => {
    expect(nextShare([1, 'auto', 2], 0)).toBe(2);
    expect(nextShare([1, 'auto'], 0)).toBe(-1);
  });

  it('moves the boundary between two shares, keeping their total and minimums', () => {
    const r = resizeShares([1, 'auto', 1], 0, 2, [200, 200], [120, 120], 40);
    expect(r).toEqual([1.2, 'auto', 0.8]); // the folded child between keeps its size
    // Clamped so the other side keeps its minimum: 120 px, then 150 px of 400.
    expect(resizeShares([1, 1], 0, 1, [200, 200], [120, 120], 100)).toEqual([1.4, expect.closeTo(0.6)]);
    expect(resizeShares([1, 1], 0, 1, [200, 200], [120, 150], 100)).toEqual([1.25, 0.75]);
  });
});