import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { CORE_SYNC_CALL_BUDGET_MS } from './plugins/syncReadBudget';

interface Timing { member: string; plugin?: string; ms: number; reported: boolean; active: boolean; diag(event: string, detail: Record<string, unknown>): void }
const scope = new AsyncLocalStorage<Timing>();
const turns = new Map<number, { timing: Timing; start: number }>();
let active = 0;

function record(timing: Timing, ms: number): void {
  if (!timing.active) return;
  timing.ms += ms;
  if (timing.reported || timing.ms <= CORE_SYNC_CALL_BUDGET_MS) return;
  timing.reported = true;
  timing.diag('core-call-stall', { ...(timing.plugin && { plugin: timing.plugin }), member: timing.member,
    budgetMs: CORE_SYNC_CALL_BUDGET_MS, synchronousMs: timing.ms });
}

// Hooks run only while calls are pending; elapsed worker/network waits never count as synchronous work.
const hook = createHook({
  before(id) {
    const timing = scope.getStore();
    if (timing?.active) turns.set(id, { timing, start: performance.now() });
  },
  after(id) {
    const turn = turns.get(id);
    if (turn) { turns.delete(id); record(turn.timing, performance.now() - turn.start); }
  },
});

export async function measureCoreCall<T>(member: string, fn: () => T, diag: Timing['diag'], plugin?: string): Promise<Awaited<T>> {
  const timing: Timing = { member, plugin, ms: 0, active: true, reported: false, diag };
  if (!active++) hook.enable();
  try {
    return await scope.run(timing, () => {
      const start = performance.now();
      try { return fn(); }
      finally { record(timing, performance.now() - start); }
    });
  } finally {
    timing.active = false;
    if (!--active) hook.disable();
  }
}
