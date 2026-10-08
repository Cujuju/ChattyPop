// Read the embedded client's experiment and permission helpers; unknown bundle shapes fail closed.
import type { WebContents } from 'electron';
import { snowflakeArg } from '@shared/discord';
import type { ScheduledAvailability } from '@shared/scheduledMessages';

export interface ScheduledAccount extends ScheduledAvailability { userId: string | null }

export function scheduledProbe(channelId?: string): string {
  if (channelId !== undefined) snowflakeArg(channelId, 'channel');
  return `(() => {
    const runtimes = [];
    const chunks = globalThis.webpackChunkdiscord_app;
    if (!chunks) return null;
    chunks.push([["chattypop-schedule-" + crypto.randomUUID()], {}, r => runtimes.push(r)]);
    chunks.pop();
    for (const r of runtimes) {
      const entry = Object.entries(r.m).find(([, f]) => String(f).includes('2026-08-scheduled-messages'));
      if (!entry) continue;
      const helpers = Object.values(r(entry[0]));
      const limits = helpers.find(f => typeof f === 'function' && /getConfig/.test(String(f)) && /PremiumTypes/.test(String(f)));
      const canUse = helpers.find(f => typeof f === 'function' && /getConfig/.test(String(f)) && /SEND_MESSAGES/.test(String(f)));
      const channelEntry = Object.entries(r.m).find(([, f]) => /displayName\\s*=\\s*["']ChannelStore/.test(String(f)));
      const userEntry = Object.entries(r.m).find(([, f]) => /displayName\\s*=\\s*["']UserStore/.test(String(f)));
      if (!limits || !canUse || !channelEntry || !userEntry) return null;
      const channels = Object.values(r(channelEntry[0])).find(v => v && typeof v.getChannel === 'function');
      const users = Object.values(r(userEntry[0])).find(v => v && typeof v.getCurrentUser === 'function');
      const userId = users?.getCurrentUser()?.id ?? null;
      const config = limits('ChattyPopSchedule');
      const id = ${JSON.stringify(channelId ?? null)};
      const channel = id === null ? null : channels?.getChannel(id);
      return { userId, limit: config.limit, enabled: !!userId && config.limit > 0 && (id === null || !!channel && canUse(channel, 'ChattyPopSchedule')) };
    }
    return null;
  })()`;
}

export async function readScheduledAccount(cdp: Pick<WebContents['debugger'], 'sendCommand'>, channelId?: string): Promise<ScheduledAccount> {
  try {
    const result = await cdp.sendCommand('Runtime.evaluate', { expression: scheduledProbe(channelId), returnByValue: true });
    const value = result.result?.value as Partial<ScheduledAccount> | null;
    if (!result.exceptionDetails && value && typeof value.enabled === 'boolean' && Number.isSafeInteger(value.limit) && typeof value.userId === 'string') {
      return { enabled: value.enabled, limit: Math.max(0, value.limit!), userId: value.userId };
    }
  } catch { /* The page may still be loading. */ }
  return { enabled: false, limit: 0, userId: null };
}
