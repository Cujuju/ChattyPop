// Whether the account may schedule messages, read from the embedded client's gateway traffic as its own client reads it:
// READY and STATE_UPDATE carry its experiment assignments; OwnerAccount carries the plan.
import type { ScheduledAvailability } from '@shared/scheduledMessages';
import type { OwnerAccount } from './account';
import type { GatewayTap } from './gatewayTap';

export interface ScheduledAccount extends ScheduledAvailability { userId: string | null }

/** Discord's experiment gating scheduled messages; assignments name it by its hash (murmur3). */
const EXPERIMENT = '2026-08-scheduled-messages';
/** Assignments are grouped by unit type, then by unit id: 1 is the user unit. */
const USER_UNIT = '1';
/** The variants the client defines for the experiment; any other falls back to its default, off. */
const ENABLED_VARIANTS = new Set([1, 2]);
/** Assignment flag: the assignment marks eligibility only, so the client reads the experiment as off. */
const USE_AS_ELIGIBILITY = 8;
/** Nitro's premium_type: the client lifts the experiment's limit to a fixed one. */
const PREMIUM_NITRO = 2;
const NITRO_LIMIT = 25;

/** An assignment as the gateway sends it: hashed name, variant, flags, revision, tracked variant, config JSON. */
type Assignment = [number, number, number?, number?, number?, string?];
interface ApexExperiments {
  assignments?: Record<string, Record<string, { assignments?: Assignment[] }> | undefined>;
}

/** MurmurHash3 (x86, 32-bit) of the name's UTF-8 bytes, unsigned: the client's hash for experiment names. */
export function murmur3(key: string, seed = 0): number {
  const bytes = new TextEncoder().encode(key);
  const mix = (k: number): number => Math.imul(rotl(Math.imul(k, 0xcc9e2d51), 15), 0x1b873593);
  const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));
  let h = seed >>> 0;
  let i = 0;
  for (; i + 4 <= bytes.length; i += 4) {
    h ^= mix(bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24));
    h = (Math.imul(rotl(h, 13), 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  for (let j = bytes.length - 1; j >= i; j--) k = (k << 8) | bytes[j]!;
  if (bytes.length > i) h ^= mix(k);
  h ^= bytes.length;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const EXPERIMENT_HASH = murmur3(EXPERIMENT);

/** The experiment's limit for `userId` in `apex`; null when the payload doesn't assign it, 0 when it assigns it off. */
export function assignedLimit(apex: ApexExperiments | undefined, userId: string): number | null {
  const unit = apex?.assignments?.[USER_UNIT]?.[userId];
  if (!unit) return null;
  const a = unit.assignments?.find(([hash]) => hash === EXPERIMENT_HASH);
  if (!a) return 0;
  const [, variant, flags = 0, , , config] = a;
  if (!ENABLED_VARIANTS.has(variant) || flags & USE_AS_ELIGIBILITY || !config) return 0;
  try {
    const limit = (JSON.parse(config) as { limit?: unknown }).limit;
    return Number.isSafeInteger(limit) && (limit as number) > 0 ? (limit as number) : 0;
  } catch {
    return 0;
  }
}

/** Follows the account's assignment; a payload that doesn't name the account keeps the last one, as the client does. */
export class ScheduledGate {
  private limits = new Map<string, number>();

  /** Subscribe before the client opens its socket, as OwnerAccount does, or READY is missed. */
  constructor(tap: GatewayTap, private readonly owner: Pick<OwnerAccount, 'userId' | 'premiumType'>) {
    tap.on('dispatch', ({ t, d }) => {
      if (t !== 'READY' && t !== 'STATE_UPDATE') return;
      const r = d as { user?: { id?: string }; apex_experiments?: ApexExperiments };
      const userId = r.user?.id ?? owner.userId;
      const limit = userId ? assignedLimit(r.apex_experiments, userId) : null;
      if (userId && limit !== null) this.limits.set(userId, limit);
    });
  }

  get account(): ScheduledAccount {
    const userId = this.owner.userId;
    const limit = userId ? (this.limits.get(userId) ?? 0) : 0;
    if (!userId || limit === 0) return { enabled: false, limit: 0, userId };
    return { enabled: true, limit: this.owner.premiumType === PREMIUM_NITRO ? NITRO_LIMIT : limit, userId };
  }
}
