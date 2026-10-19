import { describe, it } from 'vitest';

/** Includes native fixture insertion on a shared machine, outside the measured calls. */
const FIXTURE_TIMEOUT_MS = 180_000;

/** A skipped benchmark must not load the Core/native fixture stack. */
describe.runIf(process.env.CHATTYPOP_STARTUP_BENCH === '1')('startup Core turns at archive scale', () => {
  it('records synchronous reference costs on a disposable archive', async () => {
    const { benchStartupCore } = await import('./startupCoreBench');
    await benchStartupCore();
  }, FIXTURE_TIMEOUT_MS);
});
