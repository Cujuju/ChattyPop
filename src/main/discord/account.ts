import { planPerks, type PlanPerks } from '@shared/compose';
import type { GatewayTap } from './gatewayTap';

interface RawAccount {
  id: string;
  premium_type?: number;
}

/** The signed-in account's plan and gateway session, read from the embedded client's gateway traffic (READY, USER_UPDATE). */
export class OwnerAccount {
  private id: string | null = null;
  private premiumType = 0;
  private session: string | null = null;

  /** Subscribe before the client opens its socket (as the tap requires), or READY is missed. */
  constructor(tap: GatewayTap) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') {
        const r = d as { user?: RawAccount; session_id?: string };
        this.set(r.user ?? null);
        this.session = r.session_id ?? null;
      }
      // USER_UPDATE carries only the signed-in user; the id check guards against a READY for another account.
      else if (t === 'USER_UPDATE' && (d as RawAccount).id === this.id) this.set(d as RawAccount);
    });
  }

  /** The account READY last named; null before the first READY. */
  get userId(): string | null {
    return this.id;
  }

  get perks(): PlanPerks {
    return planPerks(this.premiumType);
  }

  /** The client's gateway session: interactions name it, and their results arrive on it. A resume keeps it. */
  get sessionId(): string {
    if (!this.session) throw new Error('The live Discord client has not connected yet.');
    return this.session;
  }

  private set(u: RawAccount | null): void {
    this.id = u?.id ?? null;
    this.premiumType = u?.premium_type ?? 0;
  }
}
