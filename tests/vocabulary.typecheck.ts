// Jev switches' and notice kinds' type contract (docs/plugin-architecture.md §3, §4): a plugin names only the switches
// and kinds its descriptor declares (or the host's switches); the host stamps them. Checked by `pnpm typecheck`.
import { definePlugin } from '@plugin-sdk/shared';
import type { CoreContext } from '@plugin-sdk/core';
import type { MainContext } from '@plugin-sdk/main';

const manifest = { id: 'typed', name: 'Typed', version: '1', description: '' };
const plugin = definePlugin({
  manifest,
  jev: { features: [{ key: 'probeSwitch', label: 'Probe', default: false }] },
  notices: [{ kind: 'probe' }],
  adopts: { jevFeatures: { oldSwitch: 'probeSwitch' }, noticeKinds: { old: 'probe' } },
});

declare const core: CoreContext<typeof plugin>;
core.jev.decider('probeSwitch');
core.jev.decider('pluginDecide');
export const on: boolean = core.jev.isOn('probeSwitch');
core.jev.questions.register({ subject: 'probe', feature: 'probeSwitch', question: () => null });
// @ts-expect-error: a switch it doesn't declare
core.jev.decider('linkWorth');
// @ts-expect-error: stored (stamped) names are the host's; a plugin names its own
core.jev.isOn('typed.probeSwitch');
// @ts-expect-error: a question turned on by a switch it doesn't declare
core.jev.questions.register({ subject: 'probe', feature: 'missing', question: () => null });

declare const main: MainContext<typeof plugin>;
void main.notifications.show({ title: '', body: '', target: null, kind: 'probe' });
// @ts-expect-error: a kind it doesn't declare
void main.notifications.show({ title: '', body: '', target: null, kind: 'alert' });

// @ts-expect-error: adopted switches land on a declared switch
definePlugin({ manifest, jev: { features: [{ key: 'a', default: false }] }, adopts: { jevFeatures: { old: 'b' } } });
// @ts-expect-error: adopted notice kinds land on a declared kind
definePlugin({ manifest, notices: [{ kind: 'a' }], adopts: { noticeKinds: { old: 'b' } } });
