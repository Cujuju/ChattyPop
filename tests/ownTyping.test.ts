// The owner's typing reaches Discord as the client sends it: a body-less POST per channel, renewed, restarted by their message.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayDispatch } from '../src/main/discord/gatewayTap';
import { OwnerTyping, TYPING_RENEW_MS } from '../src/main/discord/ownTyping';
import { TYPING_TTL_MS } from '@shared/typing';

const C1 = '1000000000000000001';
const C2 = '1000000000000000002';
const ME = '1000000000000000009';

function setup() {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch] }>();
  const sent: [string, unknown][] = [];
  let guard: (() => void) | undefined;
  const api = {
    postOnce: async (path: string, body: unknown, opts?: { guard?: () => void }) => {
      guard = opts?.guard;
      sent.push([path, body]);
      return undefined as never;
    },
  };
  const typing = new OwnerTyping(tap as never, { userId: ME }, api);
  return { tap, sent, typing, guard: () => guard?.() };
}

describe("the owner's typing", () => {
  it('sends once per channel until it needs renewing; their own message restarts it, others’ don’t', async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      await f.typing.typing(C1);
      await f.typing.typing(C1);
      await f.typing.typing(C2);
      expect(f.sent).toEqual([
        [`channels/${C1}/typing`, undefined],
        [`channels/${C2}/typing`, undefined],
      ]);
      vi.advanceTimersByTime(TYPING_RENEW_MS - 1);
      await f.typing.typing(C1);
      expect(f.sent).toHaveLength(2);
      vi.advanceTimersByTime(1);
      await f.typing.typing(C1);
      expect(f.sent).toHaveLength(3);
      f.tap.emit('dispatch', { t: 'MESSAGE_CREATE', s: 1, d: { channel_id: C1, author: { id: '1000000000000000008' } } });
      await f.typing.typing(C1);
      expect(f.sent).toHaveLength(3);
      f.tap.emit('dispatch', { t: 'MESSAGE_CREATE', s: 2, d: { channel_id: C1, author: { id: ME } } });
      await f.typing.typing(C1);
      expect(f.sent).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a typing held past the time it would show for', async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      await f.typing.typing(C1);
      expect(() => f.guard()).not.toThrow();
      vi.advanceTimersByTime(TYPING_TTL_MS);
      expect(() => f.guard()).toThrow('stale');
    } finally {
      vi.useRealTimers();
    }
  });
});
