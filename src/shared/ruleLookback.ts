// Message-triggered window action lookback choices.
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN } from './units';

/** Window actions cover this much time before the message by default. */
export const DEFAULT_ACTION_LOOKBACK_MS = MS_PER_HOUR;
/** Lookback choices offered in the Rules editor: from a burst of chat to a day's worth. */
export const ACTION_LOOKBACKS: readonly { ms: number; label: string }[] = [
  { ms: 15 * MS_PER_MIN, label: 'The 15 min before' },
  { ms: DEFAULT_ACTION_LOOKBACK_MS, label: 'The hour before' },
  { ms: 6 * MS_PER_HOUR, label: 'The 6 hours before' },
  { ms: MS_PER_DAY, label: 'The day before' },
];
