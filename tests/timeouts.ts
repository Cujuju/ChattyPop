// The test run's time budgets, shared by vitest.config.ts and the setup that applies them where vitest has no setting.

/**
 * A test's (and its hooks') own time before it fails as stuck. Tests open real SQLite files through every migration; on a busy hosted
 * runner that runs up to 7× its usual time (a 0.75 s test past 5 s), so vitest's 5 s default fails sound tests.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * How long a wait for a condition (vi.waitFor, expect.poll) keeps checking. Vitest's 1 s default fails sound tests under the
 * same load. Half the test's budget: the wait reports its own last failure first and leaves the rest for the test's other steps.
 * A passing wait ends as soon as its condition holds, so the budget costs only failing tests time.
 */
export const WAIT_TIMEOUT_MS = TEST_TIMEOUT_MS / 2;
