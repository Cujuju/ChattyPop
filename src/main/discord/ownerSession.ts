// Which account the captured credential is, proven passively: the gateway socket that IDENTIFYs with that token names it in
// READY. Each owner action is bound to the session proven when it is asked, and DiscordApi sends its writes under no other.
import { AsyncLocalStorage } from 'node:async_hooks';
import { SNOWFLAKE_ID } from '@shared/discord';
import type { HeaderCapture } from './capture';
import type { GatewayTap } from './gatewayTap';

/** Gateway opcodes the client sends: IDENTIFY starts a session (READY answers), RESUME continues one. */
const IDENTIFY_OP = 2;
const RESUME_OP = 6;

/** Refused before anything is sent: no account is proven for the captured credential yet. */
export const STILL_LOADING = 'Discord is still loading: try again once it has.';

/** An owner action's session: the account it was asked as, and the generation of that account's credential (HeaderCapture). */
export interface SessionBinding {
  account: string;
  generation: number;
}

/** Thrown before a write goes when the Discord sign-in changed after it was asked: nothing was sent. */
export class AccountChangedError extends Error {
  constructor(message = 'The Discord sign-in changed since this was asked: nothing was sent.') {
    super(message);
  }
}

const actions = new AsyncLocalStorage<SessionBinding | null>();

/** The session of the owner action running now: null when none was proven as it began, undefined outside one. */
export const actionSession = (): SessionBinding | null | undefined => actions.getStore();

type Calls = Record<string, (...args: never[]) => Promise<unknown>>;

export class OwnerSession {
  /** The socket that IDENTIFYed or resumed the proven session; its READY names the account. */
  private socket: string | null = null;
  private account: string | null = null;
  private readonly changes = new Set<() => void>();

  /** Subscribe before the client opens its socket, as the tap requires, or its IDENTIFY is missed. */
  constructor(
    tap: Pick<GatewayTap, 'on'>,
    private readonly capture: Pick<HeaderCapture, 'current' | 'sessionGeneration' | 'gatewayAuthorized' | 'expectGatewayAuthorization' | 'matchesGatewayAuthorization'>,
  ) {
    tap.on('sent', ({ op, d, socketId }) => {
      if ((op !== IDENTIFY_OP && op !== RESUME_OP) || !socketId || !d || typeof d !== 'object') return;
      const token = (d as { token?: unknown }).token;
      // A resume with the proven token keeps its account; anything else is unproven until its own READY.
      if (op === RESUME_OP && this.account !== null && capture.matchesGatewayAuthorization(token)) {
        this.socket = socketId;
        return;
      }
      this.account = null;
      this.socket = op === IDENTIFY_OP ? socketId : null;
      capture.expectGatewayAuthorization(token);
      this.changed();
    });
    tap.on('dispatch', ({ t, d, socketId }) => {
      if (t !== 'READY' || this.socket === null || socketId !== this.socket) return;
      const id = (d as { user?: { id?: unknown } } | null)?.user?.id;
      // A malformed READY proves no account.
      this.account = typeof id === 'string' && SNOWFLAKE_ID.test(id) ? id : null;
      this.changed();
    });
  }

  /** Calls `listener` after a gateway session starts (IDENTIFY, unproven RESUME) or READY names its account; a proven resume continues one. */
  onChanged(listener: () => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  /** The account READY named for the session `socketId` carries; null for any other socket. Holds while the credential is replaced. */
  accountOf(socketId: unknown): string | null {
    return socketId === this.socket ? this.account : null;
  }

  private changed(): void {
    for (const listener of this.changes) listener();
  }

  /** The account READY named for the credential captured now, which REST requests carry; null while unproven. */
  current(): SessionBinding | null {
    if (this.account === null || !this.capture.current || !this.capture.gatewayAuthorized) return null;
    return { account: this.account, generation: this.capture.sessionGeneration };
  }

  /** `calls`, each run as an owner action bound to the session proven when it is called. */
  actions<T extends Calls>(calls: T): T {
    const bound: Calls = {};
    for (const [name, call] of Object.entries(calls)) bound[name] = (...args) => actions.run(this.current(), () => call(...args));
    return bound as T;
  }
}

/** Throws unless the running owner action is `accountId`'s: what the owner wrote as one account is never sent as another. */
export function requireWrittenAs(accountId: unknown): void {
  const session = actionSession();
  if (!session) throw new Error(STILL_LOADING);
  if (session.account !== accountId) throw new AccountChangedError('Written as another Discord account than the one signed in: not sent. Edit or discard it.');
}
