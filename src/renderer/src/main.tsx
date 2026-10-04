import { render } from 'solid-js/web';
import './theme/index.css';
// The plugin registry: its stylesheets follow the theme's. Script order is free: the SDK and host modules never import
// it (tests/rendererInit.test.ts).
import './plugins/bundled';
import { App } from './App';
import { PanelWindow } from './frame/PanelWindow';
import { applyTheme } from './state/preferences';
import { onAppEvent } from './state/events';
import { revealPanel } from './state/layout';
import { PANEL_WINDOW_ID } from './state/ui';
import { promptRestoreAtStart } from './state/pluginRestore';
import { trackPopoverCovers } from './ui/popoverCover';

onAppEvent('open-panel', (e) => revealPanel(e.panelId));
// Popovers clear the native Discord view where they overlap it.
trackPopoverCovers();
// Once per plugin: Settings → Plugins offers plugins whose data remains but that aren't installed.
if (!PANEL_WINDOW_ID) void promptRestoreAtStart().catch((err: unknown) => console.error('[plugin restore]', err));

render(() => {
  applyTheme();
  return PANEL_WINDOW_ID ? <PanelWindow id={PANEL_WINDOW_ID} /> : <App />;
}, document.getElementById('root')!);
