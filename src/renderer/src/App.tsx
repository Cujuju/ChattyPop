import { Overlays } from '@/frame/Overlays';
import { TopBar } from '@/frame/TopBar';
import { LayoutRoot } from '@/layout/LayoutRoot';
import { syncSplashTheme, syncUnreadBadge } from '@/state/desktop';
import { currentLayout } from '@/state/layout';
import { listenForShortcuts } from '@/state/shortcuts';
import { showStorageNotice } from '@/state/storage';
import { PanelDialogs } from '@/views/panelDialog/PanelDialogs';
import { SettingsDialog } from '@/views/settings/SettingsDialog';
import { ChannelSwitcher } from '@/views/switcher/ChannelSwitcher';

export function App() {
  syncUnreadBadge();
  syncSplashTheme();
  listenForShortcuts();
  showStorageNotice();
  // Structural frame only: top bar over the layout area.
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', width: '100%', height: '100%' }}>
      <TopBar />
      <div style={{ flex: '1 1 0', 'min-height': 0, display: 'flex' }}>
        <LayoutRoot root={currentLayout().root} />
      </div>
      <SettingsDialog />
      <PanelDialogs />
      <ChannelSwitcher />
      <Overlays />
    </div>
  );
}
