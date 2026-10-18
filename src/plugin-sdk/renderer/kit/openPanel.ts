import { revealPanel } from '@/state/layout';
import { inCompanion } from '@/state/ui';
import { dispatchAppEvent } from '../appEvents';

/** Reveals a desktop panel or selects its phone section through this window's app-event listeners. */
export function openPanel(panelId: string): void {
  if (inCompanion) dispatchAppEvent({ type: 'open-panel', panelId });
  else revealPanel(panelId);
}
