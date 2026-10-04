// Plan limits are read per provider, on first ask; a refresh re-reads only the provider asked for.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { PlanUsageWindow } from '@shared/contract';

// The client runtime, so resources react as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const HOUR_MS = 3_600_000;
const WINDOW: PlanUsageWindow = { id: '5h', label: '5 hours', usedPercent: 1, resetsAt: '2026-09-29T12:00:00Z', durationMs: 5 * HOUR_MS };
const env = vi.hoisted(() => ({
  planUsage: {} as Record<string, () => Promise<PlanUsageWindow[] | null>>,
  planReads: [] as string[],
}));

vi.stubGlobal('window', {
  chattypop: {
    onEvent: () => undefined,
    core: {
      aiPlanUsage: (id: string) => {
        env.planReads.push(id);
        return env.planUsage[id]!();
      },
    },
  },
});

// The renderer module, imported by path so the node type-check doesn't follow it.
const HOST_USAGE = '../src/renderer/src/state/providerUsage';
type Store = {
  planUsageOf(id: string): PlanUsageWindow[] | null | undefined;
  planUsageFailureOf(id: string): string | null;
  refetchPlanUsage(id?: string): void;
};
const store = async (): Promise<Store> => (await import(HOST_USAGE)) as Store;

/** Lets awaited continuations and resource loads run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('Plan limits per provider', () => {
  it('read each provider on first ask; a refresh after work re-reads only that provider', async () => {
    const { planUsageOf, planUsageFailureOf, refetchPlanUsage } = await store();
    env.planUsage = { codex: async () => [WINDOW], openrouter: async () => { throw new Error('offline'); } };
    env.planReads = [];
    planUsageOf('codex');
    planUsageOf('openrouter');
    await settle();
    expect(planUsageOf('codex')).toEqual([WINDOW]);
    expect(planUsageFailureOf('openrouter')).toBe('offline');
    expect(planUsageFailureOf('codex')).toBeNull();

    env.planReads = [];
    refetchPlanUsage('codex');
    await settle();
    expect(env.planReads).toEqual(['codex']);
  });
});
