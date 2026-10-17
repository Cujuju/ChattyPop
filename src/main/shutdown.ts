// The app's quit: one sequence, however many requests reach it, so plugin cleanup finishes while core still runs.
import { errorMessage } from '@shared/errors';
import { PLUGIN_STOP_DEADLINE_MS } from '@shared/plugins';

/** What quitting runs, in this order. */
export interface ShutdownSteps {
  /** Synchronous saves (the Discord session's storage, window shapes). */
  flush(): void;
  /** Stops plugins' switch-governed resources; their cleanup may still call core. */
  stopPlugins(): Promise<void>;
  /** Ends the core process. */
  disposeCore(): void;
  quit(): void;
  diag(event: string, detail?: Record<string, unknown>): void;
}

export interface Shutdown {
  /** Starts the sequence, or joins the one under way; resolves once it has asked the app to quit. */
  run(): Promise<void>;
  /** Whether the sequence has run to its quit: a quit request after it may proceed. */
  done(): boolean;
}

/** Flushes, stops plugin resources (bounded by `deadlineMs`; a failure or overrun is logged), then ends core and quits. */
export function shutdownSequence(steps: ShutdownSteps, deadlineMs: number = PLUGIN_STOP_DEADLINE_MS): Shutdown {
  let running: Promise<void> | null = null;
  let finished = false;
  const stopPlugins = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overrun = new Promise<'overrun'>((settle) => (timer = setTimeout(() => settle('overrun'), deadlineMs)));
    try {
      const outcome = await Promise.race([steps.stopPlugins().then(() => 'stopped' as const), overrun]);
      if (outcome === 'overrun') steps.diag('plugin-stop-overran', { deadlineMs });
    } catch (err) {
      steps.diag('plugin-stop-failed', { message: errorMessage(err) });
    } finally {
      clearTimeout(timer);
    }
  };
  const sequence = async (): Promise<void> => {
    try {
      steps.flush();
    } catch (err) {
      steps.diag('quit-flush-failed', { message: errorMessage(err) });
    }
    await stopPlugins();
    try {
      steps.disposeCore();
    } finally {
      finished = true;
      steps.quit();
    }
  };
  return { run: () => (running ??= sequence()), done: () => finished };
}
