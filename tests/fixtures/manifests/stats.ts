// Activity: who posts most, when, and in which channels, for the shown channel, its server or everything.
import { defineChannels, definePlugin, definePreference } from '@plugin-sdk/shared';
import { STATS_RANGES, STATS_SCOPES, isKey, type ActivityQuery, type ActivityStats, type StatsRange, type StatsScope } from './types';

export const manifest = {
  id: 'stats',
  name: 'Activity',
  version: '1.0.0',
  description: 'The Activity panel: message counts by person, day, hour and channel.',
};

/** Its panel's layout id; saved layouts from before it was a plugin already name it. */
export const STATS_PANEL = 'stats' as const;

/** Core's calls, from the panel. */
export interface StatsCoreCalls {
  activityStats(q: ActivityQuery): ActivityStats;
}

export const plugin = definePlugin({
  manifest,
  channels: defineChannels<{ core: StatsCoreCalls }>()({ core: { activityStats: ['renderer'] } }),
  // The panel's scope and range choices.
  preferences: {
    scope: definePreference<StatsScope>({ default: 'channel', normalize: (v) => (isKey(STATS_SCOPES)(v) ? v : 'channel') }),
    range: definePreference<StatsRange>({ default: '30d', normalize: (v) => (isKey(STATS_RANGES)(v) ? v : '30d') }),
  },
  // The panel's choices from when it was built in.
  adopts: { settings: { 'stats.scope': 'scope', 'stats.range': 'range' } },
  // A bar chart's baseline and three bars.
  panels: [{ id: STATS_PANEL, title: 'Activity', importance: 'reference', dialog: true, after: 'tags', iconPath: 'M4 20h16M7 16v-5M12 16V6M17 16v-8' }],
});
export default plugin;
