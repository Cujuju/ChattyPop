// A wait for a condition (vi.waitFor, expect.poll) has the run's wait budget, not vitest's 1 s default: a loaded full-suite
// run is slower than that, so a sound test failed only for the clock (#273).
import { describe, expect, it, vi } from 'vitest';

/** Vitest's own default wait, which a loaded run outlasts. */
const VITEST_DEFAULT_WAIT_MS = 1_000;
/** A condition that comes true just past that default, as slow work does under load. */
const PAST_DEFAULT_MS = VITEST_DEFAULT_WAIT_MS * 1.5;

const trueAfter = (ms: number): (() => boolean) => {
  const start = Date.now();
  return () => Date.now() - start >= ms;
};

describe("a test's wait for a condition", () => {
  it('vi.waitFor waits past 1 s by default', async () => {
    const done = trueAfter(PAST_DEFAULT_MS);
    await vi.waitFor(() => expect(done()).toBe(true));
  });

  it('expect.poll waits past 1 s by default', async () => {
    await expect.poll(trueAfter(PAST_DEFAULT_MS)).toBe(true);
  });

  it("keeps a call's own timeout", async () => {
    await expect(vi.waitFor(() => expect(false).toBe(true), { timeout: 10 })).rejects.toThrow();
  });
});
