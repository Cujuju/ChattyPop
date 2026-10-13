import { Overlays } from '@/frame/Overlays';
import { TopBar } from '@/frame/TopBar';
import { LayoutRoot } from '@/layout/LayoutRoot';
import { syncSplashTheme, syncUnreadBadge } from '@/state/desktop';
import { currentLayout } from '@/state/layout';
import { listenForShortcuts } from '@/state/shortcuts';
import { showStorageNotice } from '@/state/storage';
import { PanelDialogs } from '@/views/panelDialog/PanelDialogs';
import { PluginWindows } from '@/views/pluginWindows/PluginWindows';
import { SettingsDialog } from '@/views/settings/SettingsDialog';
import { ChannelSwitcher } from '@/views/switcher/ChannelSwitcher';
import { Contained } from '@/ui/contained';

export function App() {
  syncUnreadBadge();
  syncSplashTheme();
  listenForShortcuts();
  showStorageNotice();
  // Structural frame only: top bar over the layout area.
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', width: '100%', height: '100%' }}>
      <Contained name="The top bar" shows="note"><TopBar /></Contained>
      <div style={{ flex: '1 1 0', 'min-height': 0, display: 'flex' }}>
        <Contained name="The layout" shows="note"><LayoutRoot root={currentLayout().root} /></Contained>
      </div>
      <Contained name="Settings" shows="note"><SettingsDialog /></Contained>
      <Contained name="Panel windows" shows="note"><PanelDialogs /></Contained>
      <Contained name="Plugin windows" shows="note"><PluginWindows /></Contained>
      <Contained name="The channel switcher" shows="note"><ChannelSwitcher /></Contained>
      <Contained name="Menus and viewers" shows="note"><Overlays /></Contained>
    </div>
  );
}
