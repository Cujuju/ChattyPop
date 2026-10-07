import type { DiscordProbe } from '@shared/contract';
import type { OwnerAccount } from './account';
import type { HeaderCapture } from './capture';
import type { GatewayDirectory } from './directory';
import type { GatewayTap } from './gatewayTap';

const RECENT_EVENTS_KEPT = 20;
const MESSAGE_EVENTS = new Set(['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE']);

type RecentEvent = DiscordProbe['gateway']['recentMessageEvents'][number];

/** Keeps the last few message events (ids only, no content) for the probe. */
export function trackRecentMessageEvents(tap: GatewayTap): RecentEvent[] {
  const recent: RecentEvent[] = [];
  tap.on('dispatch', ({ t, d }) => {
    if (!MESSAGE_EVENTS.has(t)) return;
    const m = d as { id: string; channel_id: string; edited_timestamp?: string | null };
    recent.push({ t, channelId: m.channel_id, messageId: m.id, edited: Boolean(m.edited_timestamp) });
    if (recent.length > RECENT_EVENTS_KEPT) recent.shift();
  });
  return recent;
}

/** Reports session health from what the client already sent and received: it makes no request. */
export function probeDiscord(capture: HeaderCapture, tap: GatewayTap, recent: RecentEvent[], account: Pick<OwnerAccount, 'username'>, directory: Pick<GatewayDirectory, 'guildList'>): DiscordProbe {
  const base = {
    loggedIn: capture.current !== undefined,
    capturedAt: capture.current?.capturedAt ?? null,
    observedLimits: [...capture.observedLimits],
    gateway: {
      compress: tap.stats.compress,
      frames: tap.stats.frames,
      decodeErrors: tap.stats.decodeErrors,
      events: { ...tap.stats.events },
      recentMessageEvents: [...recent],
    },
  };
  if (!base.loggedIn) return { ...base, username: null, guildCount: null, error: null };
  return { ...base, username: account.username, guildCount: directory.guildList().length, error: null };
}
