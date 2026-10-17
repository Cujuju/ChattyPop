// The app's quit sequence: plugin resources finish stopping, their cleanup reaching core, before core ends and the app quits.
import { describe, expect, it } from 'vitest';
import { whileActive } from '../src/main/plugins/states';
import { shutdownSequence, type ShutdownSteps } from '../src/main/shutdown';

/** Long enough that a sequence not awaiting it would end core first. */
const CLEANUP_DELAY_MS = 50;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The steps a quit runs, tracing each; core refuses calls once disposed. */
function traced(stopPlugins: (trace: string[], core: { call(what: string): void }) => Promise<void>) {
  const trace: string[] = [];
  let coreAlive = true;
  const core = { call: (what: string) => void trace.push(coreAlive ? `core:${what}` : `core-dead:${what}`) };
  const steps: ShutdownSteps = {
    flush: () => void trace.push('flush'),
    stopPlugins: () => stopPlugins(trace, core),
    disposeCore: () => {
      coreAlive = false;
      trace.push('core-killed');
    },
    quit: () => void trace.push('quit'),
    diag: (event) => void trace.push(`diag:${event}`),
  };
  return { trace, steps };
}

describe('the quit sequence', () => {
  it("awaits a resource's asynchronous disposer, which still reaches core, before ending core and quitting; repeated requests share one run", async () => {
    const { trace, steps } = traced(async (trace, core) => {
      const resource = whileActive('probe', () => true, () => async (reason) => {
        trace.push(`dispose:${reason}`);
        await delay(CLEANUP_DELAY_MS);
        core.call('flushed');
        trace.push('dispose-done');
      }, () => trace.push('failed'));
      await resource.sync();
      await resource.stop();
    });
    const shutdown = shutdownSequence(steps);
    const first = shutdown.run();
    expect(shutdown.run()).toBe(first);
    expect(shutdown.done()).toBe(false);
    await first;
    expect(shutdown.done()).toBe(true);
    expect(trace).toEqual(['flush', 'dispose:quit', 'core:flushed', 'dispose-done', 'core-killed', 'quit']);
  });

  it('ends core and quits after its deadline when a cleanup never finishes, and when one fails; both are logged', async () => {
    const stuck = traced(() => new Promise<void>(() => undefined));
    await shutdownSequence(stuck.steps, CLEANUP_DELAY_MS).run();
    expect(stuck.trace).toEqual(['flush', 'diag:plugin-stop-overran', 'core-killed', 'quit']);
    const failing = traced(async () => {
      throw new Error('stop failed');
    });
    await shutdownSequence(failing.steps).run();
    expect(failing.trace).toEqual(['flush', 'diag:plugin-stop-failed', 'core-killed', 'quit']);
  });
});
