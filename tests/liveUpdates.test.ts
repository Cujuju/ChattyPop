// The live-updates monitor: live once a gateway session starts on a socket the tap reads, off when none starts in time
// while signed in, so the header can warn and offer Reconnect.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_UPDATES_GRACE_MS, LiveUpdates } from '../src/main/discord/liveUpdates';
import type { GatewayChange, GatewayDispatch, GatewayTap } from '../src/main/discord/gatewayTap';
import type { AppEvent } from '../src/shared/types/ipc';

function setup(signedIn = true) {
  const tap = new EventEmitter<{ dispatch: [GatewayDispatch]; gateway: [GatewayChange] }>();
  const session = { signedIn };
  const events: AppEvent[] = [];
  const live = new LiveUpdates({
    tap: tap as unknown as Pick<GatewayTap, 'on'>,
    signedIn: () => session.signedIn,
    emit: (e) => events.push(e),
    diag: () => undefined,
  });
  const dispatch = (t: string): boolean => tap.emit('dispatch', { t, s: 1, d: {}, socketId: '1' });
  return { tap, session, events, live, dispatch };
}

describe('live updates', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('goes live on READY, and stays waiting before it', () => {
    const { live, dispatch, events } = setup();
    expect(live.state).toBe('waiting');
    dispatch('MESSAGE_CREATE');
    expect(live.state).toBe('waiting');
    dispatch('READY');
    expect(live.state).toBe('live');
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS);
    expect(live.state).toBe('live');
    expect(events).toEqual([{ type: 'live-updates', state: 'live' }]);
  });

  it('is off once the grace passes signed in with no session (the tap missed the socket)', () => {
    const { live, events } = setup();
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS - 1);
    expect(live.state).toBe('waiting');
    vi.advanceTimersByTime(1);
    expect(live.state).toBe('off');
    expect(events).toEqual([{ type: 'live-updates', state: 'off' }]);
  });

  it('waits on while signed out, and turns off a grace after it is signed in', () => {
    const { live, session } = setup(false);
    vi.advanceTimersByTime(3 * LIVE_UPDATES_GRACE_MS);
    expect(live.state).toBe('waiting');
    session.signedIn = true;
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS);
    expect(live.state).toBe('off');
  });

  it('waits again when a socket opens or the last one ends, and RESUMED makes it live', () => {
    const { live, tap, dispatch } = setup();
    dispatch('READY');
    tap.emit('gateway', 'ended');
    expect(live.state).toBe('waiting');
    tap.emit('gateway', 'opened');
    dispatch('RESUMED');
    expect(live.state).toBe('live');
    tap.emit('gateway', 'opened');
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS);
    expect(live.state).toBe('off');
  });

  it('recovers from off: a reconnect waits a fresh grace, and a session makes it live', () => {
    const { live, dispatch } = setup();
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS);
    expect(live.state).toBe('off');
    live.wait();
    expect(live.state).toBe('waiting');
    vi.advanceTimersByTime(LIVE_UPDATES_GRACE_MS - 1);
    expect(live.state).toBe('waiting');
    dispatch('READY');
    expect(live.state).toBe('live');
  });
});
