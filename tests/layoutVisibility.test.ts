// Hidden plugin panels retain their stored positions through projection, edits and resizing.
import { describe, expect, it } from 'vitest';
import { editStoredLayout, panelOwnerOff, projectLayout, projectedSizes } from '../src/renderer/src/layout/visibility';
import { bakeSizes, insertBelow, movePanel, panelIds, panelShowing, removePanel, swapPanels } from '../src/renderer/src/layout/tree';
import type { LayoutDoc, LayoutNode, LayoutPanelId, PanelRef } from '../src/renderer/src/layout/types';
import { buildPresets } from '../src/renderer/src/layout/presets';
import { createTabSelection, type TabPicks } from '../src/renderer/src/layout/tabSelection';
import { PANEL_TITLES } from '../src/renderer/src/panels/titles';
import { DIGEST_PANEL, FIXTURE_PLUGINS, NOTES_PANEL, USAGE_PANEL, notes, panelsOf } from './p2Fixtures';

const panel = (id: string): PanelRef => ({ kind: 'panel', id });
const row = (children: LayoutNode[], sizes = children.map(() => 1)): LayoutNode => ({ kind: 'split', dir: 'row', children, sizes });
const off = (id: string): boolean => id === 'summary' || id === 'alerts';
const visible = (node: LayoutNode): LayoutNode | null => projectLayout(node, off).root;
/** A pick history held in memory (the app's is a stored setting). */
const memoryPicks = (): TabPicks => {
  let recent: LayoutPanelId[] = [];
  return { recent: () => recent, pick: (id) => void (recent = [id, ...recent.filter((x) => x !== id)]) };
};
const tree = row([panel('summary'), row([panel('chat'), panel('alerts'), panel('links')], [2, 3, 4])], [5, 6]);

describe('plugin panel visibility', () => {
  it('leaves no unavailable anchors in builds with no plugin panels', () => {
    for (const doc of Object.values(buildPresets([]))) {
      expect(panelIds(doc.root).every((id) => id in PANEL_TITLES)).toBe(true);
      expect(panelIds(doc.root)).toContain('chat');
    }
  });

  it('hides only panels with a known inactive owner, including disabled and errored folder plugins', () => {
    const owner = (id: string) => id === 'summary' ? 'summaries' : undefined;
    for (const status of ['disabled', 'error'] as const) {
      const hidden = (id: string) => panelOwnerOff(id, owner, () => false, [{ id: 'folder', status, bundled: false }]);
      expect(hidden('summary')).toBe(true);
      expect(hidden('plugin:folder:panel')).toBe(true);
      expect(hidden('plugin:removed:panel')).toBe(false);
      expect(hidden('unknown')).toBe(false);
      expect(hidden('chat')).toBe(false);
    }
    expect(panelOwnerOff('summary', owner, () => true, [])).toBe(false);
    expect(panelOwnerOff('plugin:folder:panel', owner, () => false, [{ id: 'folder', status: 'active', bundled: false }])).toBe(false);
  });

  it('closes up splits without changing the document, and restores every panel when enabled', () => {
    const doc: LayoutDoc = { version: 1, name: 'Custom', root: tree };
    const saved = structuredClone(doc);
    expect(visible(doc.root)).toEqual(row([panel('chat'), panel('links')], [2, 4]));
    expect(doc).toEqual(saved);
    expect(projectLayout(doc.root, () => false).root).toEqual(tree);
    expect(projectLayout(panel('summary'), off).root).toBeNull();
    expect(visible(row([panel('summary'), panel('unknown')]))).toEqual(panel('unknown'));
  });

  it('keeps the identity of every node a projection leaves unchanged, so panels are not remounted', () => {
    expect(projectLayout(tree, () => false).root).toBe(tree);
    const tabs: LayoutNode = { kind: 'tabs', active: 1, children: [panel('chat'), panel('links')] };
    const withTabs = row([panel('summary'), tabs, row([panel('chat'), panel('links')])]);
    const shown = visible(withTabs)!;
    expect(shown.kind === 'split' && shown.children[0]).toBe(tabs);
    expect(shown.kind === 'split' && shown.children[1]).toBe(withTabs.kind === 'split' && withTabs.children[2]);
  });

  it.each([
    ['move', (root: LayoutNode) => movePanel(root, 'links', 'chat', 'top')],
    ['swap', (root: LayoutNode) => swapPanels(root, 'links', 'chat')],
    ['add', (root: LayoutNode) => insertBelow(root, 'chat', 'provider')],
    ['remove', (root: LayoutNode) => removePanel(root, 'links')],
  ] as const)('keeps hidden panels when another panel is edited: %s', (_name, edit) => {
    const saved = structuredClone(tree);
    const edited = editStoredLayout(tree, undefined, edit)!;
    expect(panelIds(edited)).toContain('summary');
    expect(panelIds(edited)).toContain('alerts');
    expect(panelIds(visible(edited)!)).not.toContain('summary');
    expect(projectLayout(edited, () => false).root).toEqual(edit(tree));
    expect(tree).toEqual(saved);
  });

  it('maps a promoted split to its stored path and retains hidden shares through resizing and later edits', () => {
    const shown = projectLayout(tree, off);
    expect(shown.splits['']?.path).toBe('1');
    const resized = projectedSizes(shown, '', [3, 3])!;
    expect(resized).toEqual({ path: '1', sizes: [3, 3, 3] });
    const overrides = { [resized.path]: resized.sizes };
    const baked = bakeSizes(tree, overrides);
    expect(visible(baked)).toEqual(row([panel('chat'), panel('links')], [3, 3]));
    expect(projectLayout(baked, () => false).root).toEqual(row([
      panel('summary'), row([panel('chat'), panel('alerts'), panel('links')], [3, 3, 3]),
    ], [5, 6]));
    const edited = editStoredLayout(tree, overrides, (root) => swapPanels(root, 'chat', 'links'))!;
    expect(projectLayout(edited, () => false).root).toEqual(row([
      panel('summary'), row([panel('links'), panel('alerts'), panel('chat')], [3, 3, 3]),
    ], [5, 6]));
  });

  it('maps shifted nested paths, leaves auto sizes alone, and rejects stale resize shapes', () => {
    const root: LayoutNode = {
      kind: 'split', dir: 'column', sizes: [4, 'auto', 8],
      children: [panel('summary'), panel('provider'), row([panel('chat'), panel('links')], [2, 6])],
    };
    const shown = projectLayout(root, off);
    expect(shown.splits['1']?.path).toBe('2');
    expect(projectedSizes(shown, '1', [1, 1])).toEqual({ path: '2', sizes: [4, 4] });
    expect(projectedSizes(shown, '', [1])).toEqual({ path: '', sizes: [4, 8] });
    expect(projectedSizes(shown, '', [1, 1])).toBeNull();
    expect(projectedSizes(shown, 'gone', [1])).toBeNull();
  });

  it('keeps the selected visible tab when earlier tabs hide and picks a survivor when the selected tab hides', () => {
    const root: LayoutNode = { kind: 'tabs', active: 2, children: [panel('summary'), panel('chat'), panel('links')] };
    expect(visible(root)).toEqual({ kind: 'tabs', active: 1, children: [panel('chat'), panel('links')] });
    expect(visible({ ...root, active: 0 })).toEqual({ kind: 'tabs', active: 0, children: [panel('chat'), panel('links')] });
  });

  it('a mounted tab group keeps the picked panel by identity while other tabs hide, and falls back when it hides', () => {
    let hidden = new Set<string>();
    const root: LayoutNode = { kind: 'tabs', active: 0, children: ['summary', 'chat', 'links', 'alerts', 'provider'].map(panel) };
    const shownTabs = (): PanelRef[] => {
      const node = projectLayout(root, (id) => hidden.has(id)).root;
      return node?.kind === 'tabs' ? node.children : [];
    };
    const tabs = createTabSelection(shownTabs, root.active, memoryPicks());
    expect(tabs.shown()).toBe('summary');
    tabs.pick('provider');
    hidden = new Set(['summary']);
    expect(tabs.shown()).toBe('provider');
    hidden = new Set(['summary', 'provider']);
    expect(tabs.shown()).toBe('chat');
    hidden = new Set();
    expect(tabs.shown()).toBe('provider');
  });

  it('groups share one pick history, each showing its own latest pick, and a new group over it restores the pick', () => {
    const picks = memoryPicks();
    const left = createTabSelection(() => ['chat', 'links'].map(panel), 0, picks);
    const right = createTabSelection(() => ['summary', 'alerts'].map(panel), 0, picks);
    right.pick('alerts');
    left.pick('links');
    expect([left.shown(), right.shown()]).toEqual(['links', 'alerts']);
    left.pick('chat');
    expect(createTabSelection(() => ['chat', 'links'].map(panel), 1, picks).shown()).toBe('chat');
    expect(right.shown()).toBe('alerts');
  });

  it("shows a panel asked for from elsewhere without another plugin's panel as its anchor", () => {
    const anchors = [USAGE_PANEL, DIGEST_PANEL];
    // A build with Notes alone: its default layouts hold neither anchor, so Notes opens outside the layout.
    for (const doc of Object.values(buildPresets(panelsOf([notes])))) expect(panelShowing(doc.root, NOTES_PANEL, anchors)).toEqual({ outside: true });
    const full = buildPresets(panelsOf(FIXTURE_PLUGINS)).stacked.root;
    expect(panelShowing(full, NOTES_PANEL, anchors)).toEqual({ below: USAGE_PANEL });
    expect(panelShowing(insertBelow(full, USAGE_PANEL, NOTES_PANEL), NOTES_PANEL, anchors)).toEqual({ placed: true });
  });
});
