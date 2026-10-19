import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/** Measures only call-owned synchronous work; helper waits are reported separately as elapsed time. */
export async function startupTurns<T>(fn: () => T) {
  const scope = new AsyncLocalStorage<boolean>();
  const starts = new Map<number, number>();
  let longestTurnMs = 0, synchronousMs = 0, active = true;
  const record = (ms: number) => { synchronousMs += ms; longestTurnMs = Math.max(longestTurnMs, ms); };
  const hook = createHook({
    before(id) { if (active && scope.getStore()) starts.set(id, performance.now()); },
    after(id) { const start = starts.get(id); if (start !== undefined) { starts.delete(id); if (active) record(performance.now() - start); } },
  });
  const start = performance.now();
  hook.enable();
  try {
    const value = await scope.run(true, () => {
      const enter = performance.now();
      try { return fn(); } finally { record(performance.now() - enter); }
    });
    return { value, longestTurnMs, synchronousMs, elapsedMs: performance.now() - start };
  } finally { active = false; hook.disable(); }
}
