// Plan usage: every enabled AI provider's plan limits, with what ChattyPop itself used of them.
import { definePlugin } from '@plugin-sdk/shared';

/** Stable layout ID preserves saved usage-panel placement. */
export const USAGE_PANEL = 'provider';

export const plugin = definePlugin({
  manifest: {
    id: 'usage',
    name: 'Plan usage',
    version: '1.0.0',
    description: "Every enabled AI provider's plan limits side by side, and what ChattyPop used of them.",
  },
  panels: [{
    id: USAGE_PANEL,
    title: 'Plan usage',
    importance: 'reference',
    dialog: false,
    // A gauge.
    iconPath: 'M3.5 17a8.5 8.5 0 1 1 17 0 M12 17l4.5-5.5 M3.5 17h17',
    after: 'sync-status',
  }],
  slots: {
    phoneDrawer: [{ id: 'plan', after: 'channels' }],
    providerRows: [{ id: 'display-name', after: 'default' }],
  },
});
export default plugin;
