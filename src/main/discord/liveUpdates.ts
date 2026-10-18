// Whether the live client's gateway traffic reaches ChattyPop. Without it no new message, DM list or alert arrives, so the
// header warns and offers Reconnect (TopBar.tsx).
import type { AppEvent, LiveUpdatesState } from '@shared/types/ipc';
import type { GatewayTap } from './gatewayTap';

/** About twice the slowest READY seen on a healthy start (21 s): longer while signed in means the tap missed the session. */
export const LIVE_UPDATES_GRACE_MS = 45_000;

/** Dispatches that start or resume a gateway session: either means the tap reads the session from its start. */
const SESSION_STARTS = new Set(['READY', 'RESUMED']);

export interface LiveUpdatesDeps {
  tap: Pick<GatewayTap, 'on'>;
  /** Whether the client is signed in; signed out, no session is expected. */
  signedIn(): boolean;
  emit(e: AppEvent): void;
  diag(event: string, data: Record<string, unknown>): void;
}

/** Live once a session starts on a socket the tap reads; waiting after a new socket or none; off when waiting outlasts the grace. */
export class LiveUpdates {
  private current: LiveUpdatesState = 'waiting';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: LiveUpdatesDeps) {
    d.tap.on('dispatch', ({ t }) => {
      if (SESSION_STARTS.has(t)) this.set('live');
    });
    d.tap.on('gateway', () => this.wait());
    this.arm();
  }

  get state(): LiveUpdatesState {
    return this.current;
  }

  /** A new session is due (a new socket, none left, or a reconnect): waiting again, off if none starts in time. */
  wait(): void {
    this.set('waiting');
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.current !== 'waiting') return;
      // Signed out (or not yet known): the login page holds no session; check again later.
      if (this.d.signedIn()) this.set('off');
      else this.arm();
    }, LIVE_UPDATES_GRACE_MS);
    this.timer.unref?.();
  }

  private set(state: LiveUpdatesState): void {
    if (state === this.current) return;
    if (state === 'live') clearTimeout(this.timer);
    this.current = state;
    this.d.diag('live-updates', { state });
    this.d.emit({ type: 'live-updates', state });
  }
}
