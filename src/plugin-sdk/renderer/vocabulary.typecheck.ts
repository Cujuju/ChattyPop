// Compile-time probe: a window names only the Jev switches its plugin declares (or the host's), and the renderer side
// gives each declared switch its Settings row and each declared notice kind its phone choice (docs/plugin-architecture.md §3).
import { definePlugin } from '@plugin-sdk/shared';
import { defineRendererPlugin } from '@plugin-sdk/renderer';
import { jevSwitch } from '@plugin-sdk/renderer/kit';

const plugin = definePlugin({
  manifest: { id: 'typed', name: 'Typed', version: '1', description: '' },
  jev: { features: [{ key: 'probeSwitch', default: false }] },
  notices: [{ kind: 'probe' }],
});

export const on: boolean = jevSwitch(plugin, 'probeSwitch').on();
jevSwitch(plugin, 'messageTags');
// @ts-expect-error: a switch it doesn't declare
jevSwitch(plugin, 'linkWorth');

const row = { group: 'Tools' as const, hint: 'Probe' };
const choice = { label: 'Probe' };
defineRendererPlugin(plugin, { jevFeatures: { probeSwitch: row }, notificationKinds: { probe: choice } });
// @ts-expect-error: every declared switch has its Settings row
defineRendererPlugin(plugin, { notificationKinds: { probe: choice } });
// @ts-expect-error: every declared notice kind its phone choice
defineRendererPlugin(plugin, { jevFeatures: { probeSwitch: row } });
// @ts-expect-error: no row for a switch it doesn't declare
defineRendererPlugin(plugin, { jevFeatures: { probeSwitch: row, other: row }, notificationKinds: { probe: choice } });
// @ts-expect-error: no choice for a kind it doesn't declare
defineRendererPlugin(plugin, { jevFeatures: { probeSwitch: row }, notificationKinds: { probe: choice, alert: choice } });
