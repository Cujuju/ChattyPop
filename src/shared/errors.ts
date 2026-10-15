/** A thrown value's message: an Error's own, else the value as text. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs one subscriber of a shared fan-out: its throw or rejected promise goes to `report`, never to the caller or later subscribers. */
export function runIsolated(run: () => unknown, report: (err: unknown) => void): void {
  try {
    void Promise.resolve(run()).catch(report);
  } catch (err) {
    report(err);
  }
}
