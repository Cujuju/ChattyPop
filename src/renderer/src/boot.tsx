// The app's start: the main window's App or a panel window's panel, once settings and the plugin list are in. Shared by
// the app's own windows (main.tsx) and a remote desktop's page (startRemoteDesktop), which load the theme and the
// plugin registry first.
import { render } from 'solid-js/web';
import { firstPaintReady } from '@plugin-sdk/renderer/firstPaint';
import { App } from './App';
import { PanelWindow } from './frame/PanelWindow';
import { applyTheme } from './state/preferences';
import { onAppEvent } from './state/events';
import { revealPanel } from './state/layout';
import { PANEL_WINDOW_ID, openSettingsAt } from './state/ui';
import { promptRestoreAtStart } from './state/pluginRestore';
import { holdImeKeys } from './ui/keys';
import { trackPopoverCovers } from './ui/popoverCover';
import { Contained } from './ui/contained';

function Root() {
  applyTheme();
  return PANEL_WINDOW_ID ? <PanelWindow id={PANEL_WINDOW_ID} /> : <App />;
}

export function startApp(): void {
  // First of this window's key listeners: an input method's keys reach no app handler.
  holdImeKeys(window);
  onAppEvent('open-panel', (e) => revealPanel(e.panelId));
  onAppEvent('open-settings', (e) => openSettingsAt(e.section));
  // Popovers clear the native Discord view where they overlap it.
  trackPopoverCovers();
  // Once per plugin: Settings → Plugins offers plugins whose data remains but that aren't installed.
  if (!PANEL_WINDOW_ID) void promptRestoreAtStart().catch((err: unknown) => console.error('[plugin restore]', err));

  // Waits for stored settings and the plugin list: rendering on fallbacks would flash the default layout and theme.
  void firstPaintReady().then(() =>
    render(() => <Contained name="ChattyPop" shows="reload"><Root /></Contained>, document.getElementById('root')!),
  );
}
