import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { servedCall } from '../src/core/plugins/callStalls';
import { CORE_SYNC_CALL_BUDGET_MS } from '../src/core/plugins/syncReadBudget';

/** Twice the budget ensures the assertion is independent of clock resolution. */
const OVER_BUDGET_MS = CORE_SYNC_CALL_BUDGET_MS * 2;
const busy = (): void => { const until = performance.now() + OVER_BUDGET_MS; while (performance.now() < until) { /* deliberate test work */ } };
const context = (diag: (event: string, detail: Record<string, unknown>) => void) => ({
  plugin: 'stallprobe', member: 'slow', reads: false, strict: true,
  signal: new AbortController().signal, priority: 'interactive' as const, diag,
});

it('names synchronous work before and after awaits once per call', async () => {
  for (const afterAwait of [false, true]) {
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    await servedCall(context((event, detail) => events.push({ event, detail })), async () => {
      if (afterAwait) await Promise.resolve();
      busy();
      busy();
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'core-call-stall', detail: {
      plugin: 'stallprobe', member: 'slow', budgetMs: CORE_SYNC_CALL_BUDGET_MS,
    } });
  }
});

it('does not charge waiting for a worker or another concurrent call', async () => {
  const events: unknown[] = [];
  await servedCall(context((...args) => events.push(args)), async () => {
    await new Promise((resolve) => setTimeout(resolve, OVER_BUDGET_MS));
  });
  expect(events).toEqual([]);
});
