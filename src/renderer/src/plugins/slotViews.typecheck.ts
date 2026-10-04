// Compile-time probe: a renderer side gives a view for exactly each slot item its descriptor declares.
import { defineRendererPlugin } from '@plugin-sdk/renderer';
import { definePlugin } from '@plugin-sdk/shared';

const Component = () => null;
const plugin = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  slots: {
    topBar: [{ id: 'bell', after: 'privacy' }],
    messageMenu: [{ id: 'menu', before: 'jev' }],
  },
});
const bare = definePlugin({ manifest: { id: 'bare', name: 'Bare', version: '1', description: '' } });

export function checkSlotViews(): void {
  defineRendererPlugin(plugin, { topBar: { bell: { Component } }, messageMenu: { menu: { calls: [], menu: () => [] } } });
  // A view's callbacks take their parameter types from the slot: no implicit any.
  defineRendererPlugin(plugin, { topBar: { bell: { Component } }, messageMenu: { menu: { calls: [], menu: (m, scope) => (m.id && scope ? [] : []) } } });
  // @ts-expect-error A declared item needs its view.
  defineRendererPlugin(plugin, { topBar: { bell: { Component } } });
  // @ts-expect-error Each declared id needs its view, by local id.
  defineRendererPlugin(plugin, { topBar: {}, messageMenu: { menu: { calls: [], menu: () => [] } } });
  // @ts-expect-error A view needs a declaration.
  defineRendererPlugin(plugin, { topBar: { bell: { Component }, extra: { Component } }, messageMenu: { menu: { calls: [], menu: () => [] } } });
  // @ts-expect-error A plugin that declares no items gives no views.
  defineRendererPlugin(bare, { statusBar: { status: { Component } } });
  const hover = definePlugin({ manifest: { id: 'hover', name: 'Hover', version: '1', description: '' }, slots: { hoverActions: [{ id: 'pin', before: 'reply' }], chatFooter: [{ id: 'box' }] } });
  defineRendererPlugin(hover, { hoverActions: { pin: { Component } }, chatFooter: { box: { Component } } });
  // @ts-expect-error A declared hover action and footer item each need their view.
  defineRendererPlugin(hover, { hoverActions: { pin: { Component } } });
  // @ts-expect-error One placement direction per item.
  definePlugin({ manifest: { id: 'two', name: 'Two', version: '1', description: '' }, slots: { topBar: [{ id: 'x', after: 'layout', before: 'settings' }] } });
}
