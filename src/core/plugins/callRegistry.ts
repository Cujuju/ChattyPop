import type { Audience } from '@shared/pluginChannels';
import type { PluginCallRequest } from '@shared/readPriority';
import { CALL_ID } from '@shared/readPriority';

/** Covers HTTP reordering without retaining cancelled call identities indefinitely. */
const CANCEL_RETENTION_MS = 60_000;
/** Bounds tombstones across windows; exceeds both read queues and ordinary cancellation bursts. */
const CANCELLED_CALLS_MAX = 256;

/** Call ids are scoped by transport origin and plugin; early HTTP cancels survive until their request arrives. */
export class PluginCallRegistry {
  private readonly active = new Map<string, AbortController>();
  private readonly cancelled = new Map<string, number>();
  private key(origin: Audience, plugin: string, id: string): string { return JSON.stringify([origin, plugin, id]); }

  start(origin: Audience, plugin: string, request?: PluginCallRequest): { signal: AbortSignal; end(): void } {
    const controller = new AbortController();
    if (!request) return { signal: controller.signal, end() {} };
    const key = this.key(origin, plugin, request.id);
    if (this.active.has(key)) throw new Error('Duplicate plugin call id');
    const cancelledAt = this.cancelled.get(key);
    this.cancelled.delete(key);
    if (cancelledAt !== undefined && Date.now() - cancelledAt < CANCEL_RETENTION_MS) controller.abort(new Error('Plugin call cancelled'));
    this.active.set(key, controller);
    return { signal: controller.signal, end: () => { this.active.delete(key); } };
  }

  cancel(origin: Audience, plugin: string, id: string): void {
    if (!CALL_ID.test(id)) throw new Error('Bad plugin cancel id');
    const key = this.key(origin, plugin, id);
    const active = this.active.get(key);
    if (active) { active.abort(new Error('Plugin call cancelled')); return; }
    const now = Date.now();
    for (const [old, at] of this.cancelled) if (now - at >= CANCEL_RETENTION_MS) this.cancelled.delete(old);
    if (this.cancelled.size >= CANCELLED_CALLS_MAX) this.cancelled.delete(this.cancelled.keys().next().value!);
    this.cancelled.set(key, now);
  }
}
