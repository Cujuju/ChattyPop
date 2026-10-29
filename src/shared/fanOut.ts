// Event fan-out shared by host code and plugin callbacks.

/** Runs one subscriber of a shared fan-out: its throw or rejected promise goes to `report`, never to the caller or later subscribers. */
export function runIsolated(run: () => unknown, report: (err: unknown) => void): void {
  try {
    void Promise.resolve(run()).catch(report);
  } catch (err) {
    report(err);
  }
}

/** Calls each of `listeners` (as they are now) with `args`, each isolated (runIsolated). */
export function fanOut<A extends unknown[]>(listeners: Iterable<(...args: A) => unknown>, args: A, report: (err: unknown) => void): void {
  for (const fn of [...listeners]) runIsolated(() => fn(...args), report);
}
