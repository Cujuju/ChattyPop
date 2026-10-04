// Providers and Jev handed out live only as long as what handed them out: a registration, or a plugin activation.
import type { DecisionProvider } from './decisions';
import type { LlmProvider } from './types';

/**
 * `run`'s result until `revoked` aborts: a call made after rejects with the abort reason, and so does one still running
 * when it aborts (at once, even if the callee ignores its signal) or whose result arrives after.
 */
export function untilRevoked<T>(revoked: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (revoked.aborted) return Promise.reject(revoked.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const revoke = (): void => reject(revoked.reason as Error);
    revoked.addEventListener('abort', revoke, { once: true });
    const settle = (): boolean => {
      revoked.removeEventListener('abort', revoke);
      return !revoked.aborted;
    };
    let running: Promise<T>;
    try {
      running = run();
    } catch (err) {
      settle();
      reject(err as Error);
      return;
    }
    running.then(
      (result) => void (settle() && resolve(result)),
      (err: unknown) => void (settle() && reject(err)),
    );
  });
}

/** `signal` and `revoked` both, for a request that either may cancel. */
export const joined = (revoked: AbortSignal, signal?: AbortSignal): AbortSignal => (signal ? AbortSignal.any([signal, revoked]) : revoked);

/**
 * `provider` until `revoked` aborts (its plugin turned off). A running completion gets the abort through its signal and
 * settles at once when `revoked` or its own signal (a deadline) aborts, even if the provider ignores it.
 */
export function revocable(provider: LlmProvider, revoked: AbortSignal): LlmProvider {
  const { planUsage } = provider;
  return {
    id: provider.id,
    maxInputChars: provider.maxInputChars,
    complete: (req) => {
      const signal = joined(revoked, req.signal);
      return untilRevoked(signal, () => provider.complete({ ...req, signal }));
    },
    listModels: () => untilRevoked(revoked, () => provider.listModels()),
    ...(planUsage ? { planUsage: () => untilRevoked(revoked, () => planUsage.call(provider)) } : {}),
  };
}

/** Jev until `revoked` aborts; a queued or running request gets the abort through its signal. */
export function revocableDecider(jev: DecisionProvider, revoked: AbortSignal): DecisionProvider {
  return {
    model: jev.model,
    maxInputChars: jev.maxInputChars,
    decide: (req) => untilRevoked(revoked, () => jev.decide({ ...req, signal: joined(revoked, req.signal) })),
  };
}
