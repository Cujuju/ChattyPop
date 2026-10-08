import { createEffect, on, type Accessor } from 'solid-js';
import { setSettingsOpen, settingsOpen } from '@/state/ui';

/** Keeps Settings' loading state in step with the pane, and opens it for external requests. */
export function trackPhoneSettingsVisibility(shown: Accessor<boolean>, onShow: () => void): void {
  createEffect(on(shown, setSettingsOpen));
  // Only an open request may show the pane. Watching `shown` here mistakes navigation
  // away for a request when this effect runs before the loading-state effect above.
  createEffect(on(settingsOpen, (open) => {
    if (open && !shown()) onShow();
  }));
}
