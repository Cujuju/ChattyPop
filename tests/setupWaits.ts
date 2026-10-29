// vi.waitFor's default timeout (1 s) has no vitest setting, unlike expect.poll's: every wait defaults to the run's
// WAIT_TIMEOUT_MS here. A call that names its own timeout keeps it.
import { vi } from 'vitest';
import { WAIT_TIMEOUT_MS } from './timeouts';

const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options = {}) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_TIMEOUT_MS, ...options })) as typeof vi.waitFor;
