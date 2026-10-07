// The owner's typing, shown to others as the client shows it: POST channels/{id}/typing while they type, renewed before it lapses.
import { TYPING_TTL_MS } from '@shared/typing';
import type { OwnerAccount } from './account';
import type { DiscordWriter } from './client';
import type { GatewayTap } from './gatewayTap';

/** Typing on renews the indicator this long after the last: inside the TTL, as clients do (about every 8–10 s), so it doesn't lapse. */
export const TYPING_RENEW_MS = 8_000;

/** Sends the owner's typing per channel, at most once a renewal; their message ends it, so typing on after one starts it again at once. */
export class OwnerTyping {
  /** When each channel's typing was last sent. */
  private readonly sentAt = new Map<string, number>();

  constructor(
    tap: Pick<GatewayTap, 'on'>,
    account: Pick<OwnerAccount, 'userId'>,
    private readonly api: Pick<DiscordWriter, 'postOnce'>,
  ) {
    tap.on('dispatch', ({ t, d }) => {
      const m = d as { channel_id?: string; author?: { id?: string } };
      if (t === 'MESSAGE_CREATE' && m.channel_id && m.author?.id !== undefined && m.author.id === account.userId) this.sentAt.delete(m.channel_id);
    });
  }

  /** The owner typed in `channelId`. */
  async typing(channelId: string): Promise<void> {
    const now = Date.now();
    const last = this.sentAt.get(channelId);
    if (last !== undefined && now - last < TYPING_RENEW_MS) return;
    this.sentAt.set(channelId, now);
    // No body, as the client sends it. One held past the TTL (a rate limit) would show typing that ended: it's dropped.
    await this.api.postOnce(`channels/${channelId}/typing`, undefined, {
      guard: () => {
        if (Date.now() - now >= TYPING_TTL_MS) throw new Error('Typing went stale before it could be sent.');
      },
    });
  }
}
