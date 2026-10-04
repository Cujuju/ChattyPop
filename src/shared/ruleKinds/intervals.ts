// Supported action floors and their wording in rule activity.
import { MS_PER_HOUR, MS_PER_MIN } from '../units';

/** Each declared floor has wording for the interval and the elapsed-time explanation. */
export const ACTION_INTERVALS: Readonly<Record<number, { unit: string; span: string }>> = {
  [MS_PER_MIN]: { unit: 'minute', span: 'a minute' },
  [MS_PER_HOUR]: { unit: 'hour', span: 'an hour' },
};

/** Rejects declaration errors when an action implementation is registered, before any rule runs. */
export function validateActionInterval(ms: number | null): void {
  if (ms !== null && !Object.hasOwn(ACTION_INTERVALS, ms)) {
    throw new Error(`Unsupported rule action interval: ${ms}.`);
  }
}
