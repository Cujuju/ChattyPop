import { createMemo, createRoot, createSignal } from 'solid-js';

/** Ages ("40s", "3m") re-render this often. */
const CLOCK_TICK_MS = 10_000;

/** Wall clock for relative ages: read it (not Date.now()) so an age label stays current. */
export const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);

/** Local midnight today: day-relative labels ("Yesterday at") re-render when the day turns, not on every tick. */
export const today = createRoot(() =>
  createMemo(() => {
    const d = new Date(now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }),
);
