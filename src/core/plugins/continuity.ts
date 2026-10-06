// Whether a bundled plugin's activation continues its previous one without a gap (CoreContext.session.resumed).
import { getSetting, setSetting, type Db } from '../db';

/**
 * Session counter and each plugin's last-activated session (dropped on turn-off). A plugin absent from a build keeps
 * its entry, so restore (footprints.ts) knows it was on; its session never resumes.
 */
export const CONTINUITY_KEY = 'plugins.continuity';

interface Stored {
  session: number;
  active: Record<string, number>;
}

/** Resumes only across uninterrupted enabled core sessions. First run, disablement, absent builds and failed starts create archive coverage gaps. */
export class ActivationContinuity {
  private previous: Stored = { session: 0, active: {} };
  private current: Stored = { session: 0, active: {} };

  constructor(private readonly db: () => Db) {}

  /** Starts this core session; once, before any bundled plugin activates. `present`: the build's plugin ids. */
  start(present: ReadonlySet<string>): void {
    this.previous = (getSetting(this.db(), CONTINUITY_KEY) as Stored | undefined) ?? this.previous;
    const absent = Object.entries(this.previous.active).filter(([id]) => !present.has(id));
    this.current = { session: this.previous.session + 1, active: Object.fromEntries(absent) };
    this.save();
  }

  /** Whether `id`, activating at startup now, was on at the end of the previous session. */
  resumed(id: string): boolean {
    return this.previous.active[id] === this.previous.session;
  }

  activated(id: string): void {
    this.current.active[id] = this.current.session;
    this.save();
  }

  deactivated(id: string): void {
    delete this.current.active[id];
    this.save();
  }

  private save(): void {
    setSetting(this.db(), CONTINUITY_KEY, this.current);
  }
}
