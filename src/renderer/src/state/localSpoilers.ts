import { createSignal } from 'solid-js';
import { api } from '@/api';
import { holdFirstPaint } from '@plugin-sdk/renderer/firstPaint';
import { onAppEvent } from '@plugin-sdk/renderer/appEvents';
import { normalizeLocalSpoilers } from '@shared/localSpoilers';
import { SETTINGS_KEYS } from '@shared/settings';

const [marks, setMarks] = createSignal<ReadonlySet<string>>(new Set());
const loaded = api.core.getSetting(SETTINGS_KEYS.localSpoilers).then((value) => setMarks(new Set(normalizeLocalSpoilers(value))));
holdFirstPaint(loaded);
onAppEvent('setting-changed', (event) => {
  if (event.key === SETTINGS_KEYS.localSpoilers) setMarks(new Set(normalizeLocalSpoilers(event.value)));
});

/** A selected part's local cover, shared by this device's windows and restored before first paint. */
export const isLocalSpoiler = (key: string | null | undefined): boolean => !!key && marks().has(key);

// Read each change against the previous settled write, so quick choices keep one another's marks.
let writing: Promise<void> = Promise.resolve();
export function setLocalSpoiler(key: string, marked: boolean): Promise<void> {
  const write = writing.catch(() => undefined).then(async () => {
    await loaded;
    const next = new Set(marks());
    if (marked) next.add(key);
    else next.delete(key);
    // Show only a successfully stored mark; a refused write leaves the previous cover intact.
    await api.core.setSetting(SETTINGS_KEYS.localSpoilers, [...next]);
    setMarks(next);
  });
  writing = write;
  return write;
}
