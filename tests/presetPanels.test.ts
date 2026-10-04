// Contract tests for preset panels.
import { describe, expect, it } from 'vitest';
import type { PanelDecl } from '@shared/bundledTypes';
import { placePresetPanels } from '../src/renderer/src/layout/presetPanels';
import { panelIds, removePanel } from '../src/renderer/src/layout/tree';
import type { LayoutNode, PanelRef } from '../src/renderer/src/layout/types';

const panel = (id: string): PanelRef => ({ kind: 'panel', id });
const declaration = (id: string, presets: PanelDecl['presets']): PanelDecl => ({
  id, title: id, importance: 'primary', dialog: false, iconPath: '', after: 'provider', presets,
});

describe('plugin preset panel placement', () => {
  it('inserts beside provider and chat in their own containers, retaining host and declared shares', () => {
    const root: LayoutNode = {
      kind: 'split', dir: 'row', sizes: [2, 5], children: [
        { kind: 'split', dir: 'column', sizes: ['auto'], children: [panel('provider')] },
        { kind: 'split', dir: 'column', sizes: [3], children: [panel('chat')] },
      ],
    };
    const before = structuredClone(root);
    const placed = placePresetPanels(root, 'stacked', [
      declaration('summary', [{ id: 'stacked', after: 'provider', size: 4 }]),
      declaration('probe', [{ id: 'stacked', before: 'chat' }]),
      declaration('other-layout', [{ id: 'tabbed', before: 'chat' }]),
    ]);
    expect(placed).toEqual({
      kind: 'split', dir: 'row', sizes: [2, 5], children: [
        { kind: 'split', dir: 'column', sizes: ['auto', 4], children: [panel('provider'), panel('summary')] },
        { kind: 'split', dir: 'column', sizes: [1, 3], children: [panel('probe'), panel('chat')] },
      ],
    });
    expect(root).toEqual(before);
  });

  it('resolves chained declarations regardless of order and keeps a dependent panel when its owner is pruned', () => {
    const root: LayoutNode = { kind: 'split', dir: 'column', sizes: ['auto', 3], children: [panel('provider'), panel('chat')] };
    const declarations = [
      declaration('dependent', [{ id: 'side', after: 'summary', size: 2 }]),
      declaration('summary', [{ id: 'side', after: 'provider', size: 4 }]),
    ];
    const placed = placePresetPanels(root, 'side', declarations);
    expect(panelIds(placed)).toEqual(['provider', 'summary', 'dependent', 'chat']);
    expect(placePresetPanels(root, 'side', [...declarations].reverse())).toEqual(placed);
    expect(removePanel(placed, 'summary')).toEqual({
      kind: 'split', dir: 'column', sizes: ['auto', 2, 3], children: [panel('provider'), panel('dependent'), panel('chat')],
    });
    expect(placePresetPanels(root, 'side', [])).toEqual(root);
  });

  it('inserts chained tabs before chat without changing their stored active index', () => {
    const root: LayoutNode = { kind: 'tabs', active: 0, children: [panel('chat'), panel('provider')] };
    expect(placePresetPanels(root, 'tabbed', [
      declaration('probe', [{ id: 'tabbed', before: 'summary' }]),
      declaration('summary', [{ id: 'tabbed', before: 'chat' }]),
    ])).toEqual({ kind: 'tabs', active: 0, children: [panel('probe'), panel('summary'), panel('chat'), panel('provider')] });
  });
});
