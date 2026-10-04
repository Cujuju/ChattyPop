// A plugin folder for the host's renderer graph and styling tests (tests/rendererGraph.ts): a desktop-only plugin.
import { definePlugin } from '@plugin-sdk/shared';

export const plugin = definePlugin({
  manifest: { id: 'p2panel', name: 'Panel probe', version: '1.0.0', description: 'Fixture: a renderer side on the contract and kit tiers.' },
});
export default plugin;
