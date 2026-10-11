import { createSignal } from 'solid-js';
import { api } from '@/api';
import { holdFirstPaint } from '@plugin-sdk/renderer/firstPaint';
import { onAppEvent } from '@plugin-sdk/renderer/appEvents';
import { normalizeLocalSpoilers } from '@shared/localSpoilers';
import { DESKTOP_CONNECTED_EVENT } from '@shared/phone';
import { SETTINGS_KEYS } from '@shared/settings';

const [marks, setMarks] = createSignal<ReadonlySet<string>>(new Set());
let revision = 0;
function adopt(value: unknown): void {
  revision++;
  setMarks(new Set(normalizeLocalSpoilers(value)));
}
async function refresh(): Promise<void> {
  const reading = revision;
  const value = await api.core.getSetting(SETTINGS_KEYS.localSpoilers);
  // A newer event or write may have reached us while this snapshot was in flight.
  if (reading === revision) adopt(value);
}
holdFirstPaint(refresh().catch(() => undefined));
onAppEvent('setting-changed', (event) => {
  if (event.key === SETTINGS_KEYS.localSpoilers) adopt(event.value);
});
// The phone's event stream does not replay changes missed while disconnected or asleep.
if (typeof window !== 'undefined') window.addEventListener(DESKTOP_CONNECTED_EVENT, () => void refresh().catch(() => undefined));

/** A selected part's personal cover, shared by this archive's devices and restored before first paint. */
export const isLocalSpoiler = (key: string | null | undefined): boolean => !!key && marks().has(key);

// Keep this window's quick choices ordered; core applies each change to the archive's latest marks.
let writing: Promise<void> = Promise.resolve();
export function setLocalSpoiler(key: string, marked: boolean): Promise<void> {
  const write = writing.catch(() => undefined).then(async () => {
    const changing = revision;
    // Show only a successfully stored mark; a refused write leaves the previous cover intact.
    const next = await api.core.setLocalSpoiler(key, marked);
    if (changing === revision) adopt(next);
  });
  writing = write;
  return write;
}
