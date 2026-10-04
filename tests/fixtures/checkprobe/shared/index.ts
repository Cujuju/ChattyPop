// A plugin folder `pnpm plugin:check` passes (tests/pluginCheck.test.ts copies it outside the checkout).
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import type { Calls } from './greeting';

export const plugin = definePlugin({
  manifest: { id: 'checkprobe', name: 'Check probe', version: '1.0.0', description: 'Fixture for pnpm plugin:check.' },
  channels: defineChannels<{ core: Calls }>()({ core: { greet: ['renderer'] } }),
});
export default plugin;
