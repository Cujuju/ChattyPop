// "Since you were last here": when the previous session was last seen, and this session's heartbeat.
import { MS_PER_DAY, MS_PER_MIN } from '@shared/units';
import { getSetting, setSetting, type Db } from './db';

const LAST_SEEN_KEY = 'session.lastSeenAt';
/** How often "the user was here" is recorded; bounds how stale "since you were last here" can be. */
const LAST_SEEN_HEARTBEAT_MS = MS_PER_MIN;
/** With no previous session, "since you were last here" covers the last day. */
const FIRST_RUN_LOOKBACK_MS = MS_PER_DAY;

/** When the previous session was last seen: its stored heartbeat, else a day before `now` (the first run). */
export function previousSeenAt(db: Db | undefined, now: number): number {
  const stored = db ? Number(getSetting(db, LAST_SEEN_KEY)) : Number.NaN;
  return Number.isFinite(stored) && stored > 0 ? stored : now - FIRST_RUN_LOOKBACK_MS;
}

/** Records this session as seen at `now`. */
export const recordSeen = (db: Db, now: number): void => setSetting(db, LAST_SEEN_KEY, now);

/**
 * Returns when the previous session was last seen, then records this session now and on every heartbeat.
 * `db` is read per beat: the database closes while the archive is moved.
 */
export function startLastSeen(db: () => Db | undefined): number {
  const previous = previousSeenAt(db(), Date.now());
  const beat = (): void => {
    const current = db();
    if (current?.open) recordSeen(current, Date.now());
  };
  beat();
  setInterval(beat, LAST_SEEN_HEARTBEAT_MS);
  return previous;
}
