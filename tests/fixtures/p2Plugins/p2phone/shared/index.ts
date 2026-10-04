// A plugin folder for the host's renderer graph and styling tests (tests/rendererGraph.ts): the phone's transport, with its own page.
import { definePlugin } from '@plugin-sdk/shared';

export const plugin = definePlugin({
  manifest: { id: 'p2phone', name: 'Phone probe', version: '1.0.0', description: 'Fixture: a phone transport whose page imports the shell tier.' },
  phone: { transport: true },
});
export default plugin;
