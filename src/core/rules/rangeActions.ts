// Ranges for actions: the triggering message’s channel before it, or a timed window over selected channels.
import type { PluginRange } from '@shared/plugins';
import type { ActionRun } from './kinds';

/** Services for range actions; message runs use a declared floor and timed runs are paced by their schedule. */
export interface RangeDeps {
  runPluginCommand(pluginId: string, commandId: string, range: PluginRange): Promise<string | null>;
}

/** The message channel through its timestamp, or the supplied window; null window channels means every archived channel. */
export const actionRange = (r: ActionRun, lookbackMs: number): PluginRange =>
  r.event.kind === 'window'
    ? r.event.range
    : {
        sinceTs: r.event.m.ts - lookbackMs,
        untilTs: r.event.m.ts,
        channelIds: [r.event.m.channelId],
      };
