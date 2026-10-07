import { api } from '@/api';
import { createSignal } from 'solid-js';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN, MS_PER_S } from '@shared/units';
import { archivedChannels } from './directory';

/** Capture state is re-checked rarely once it is on: the probe reads main's state and asks Discord nothing. */
const CAPTURE_CHECK_MS = 5 * MS_PER_MIN;
/** Short capture-probe interval during startup disconnection. */
const CAPTURE_RETRY_MS = 15 * MS_PER_S;

/** Whether the embedded Discord client is signed in and feeding live capture. */
export const [captureOn, setCaptureOn] = createSignal<boolean | null>(null);
/** Time of the newest archived message across archived channels and their threads. */
export function latestMessageTs(): number | null {
  const ts = archivedChannels({ threads: true }).map((c) => c.lastTs ?? 0);
  return Math.max(0, ...ts) || null;
}

let captureTimer: ReturnType<typeof setTimeout> | undefined;
/** Probes immediately, frequently while disconnected and sparsely while connected. */
const checkCapture = (): void => {
  clearTimeout(captureTimer);
  void api.discord
    .probe()
    .then(
      (p) => p.loggedIn,
      () => false,
    )
    .then((on) => {
      setCaptureOn(on);
      captureTimer = setTimeout(checkCapture, on ? CAPTURE_CHECK_MS : CAPTURE_RETRY_MS);
    });
};

checkCapture();

const S_PER_MIN = MS_PER_MIN / MS_PER_S;
const MIN_PER_HOUR = MS_PER_HOUR / MS_PER_MIN;
const HOURS_PER_DAY = MS_PER_DAY / MS_PER_HOUR;

/** Compact age: 40s, 3m, 2h, 5d. */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / MS_PER_S));
  if (s < S_PER_MIN) return `${s}s`;
  const m = Math.round(s / S_PER_MIN);
  if (m < MIN_PER_HOUR) return `${m}m`;
  const h = Math.round(m / MIN_PER_HOUR);
  return h < HOURS_PER_DAY ? `${h}h` : `${Math.round(h / HOURS_PER_DAY)}d`;
}
