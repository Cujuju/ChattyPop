// A component's async action: busy while its latest run is in flight, and that run's error text.
import { createSignal, type Accessor, type Setter } from 'solid-js';
import { errorText } from './format';

export interface Action {
  busy: Accessor<boolean>;
  error: Accessor<string | null>;
  setError: Setter<string | null>;
  /** Clears errors and runs jobs. Failure returns undefined with error; superseded/canceled runs discard results and errors. */
  run<T>(job: () => Promise<T>): Promise<T | undefined>;
  /** Supersedes the run in flight, e.g. when its target changed. */
  cancel(): void;
}

export function createAction(): Action {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;
  const run = async <T>(job: () => Promise<T>): Promise<T | undefined> => {
    const mine = ++generation;
    setBusy(true);
    setError(null);
    try {
      const value = await job();
      return mine === generation ? value : undefined;
    } catch (err) {
      if (mine === generation) setError(errorText(err));
      return undefined;
    } finally {
      if (mine === generation) setBusy(false);
    }
  };
  const cancel = (): void => {
    generation++;
    setBusy(false);
    setError(null);
  };
  return { busy, error, setError, run, cancel };
}
