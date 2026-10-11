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
import { trackPopoverCovers } from './ui/popoverCover';

export function startApp(): void {
  onAppEvent('open-panel', (e) => revealPanel(e.panelId));
  onAppEvent('open-settings', (e) => openSettingsAt(e.section));
  // Popovers clear the native Discord view where they overlap it.
  trackPopoverCovers();
  // Once per plugin: Settings → Plugins offers plugins whose data remains but that aren't installed.
  if (!PANEL_WINDOW_ID) void promptRestoreAtStart().catch((err: unknown) => console.error('[plugin restore]', err));

  // Waits for stored settings and the plugin list: rendering on fallbacks would flash the default layout and theme.
  void firstPaintReady().then(() =>
    render(() => {
      applyTheme();
      return PANEL_WINDOW_ID ? <PanelWindow id={PANEL_WINDOW_ID} /> : <App />;
    }, document.getElementById('root')!),
  );
}
