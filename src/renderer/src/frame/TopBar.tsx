import { For, Show, createSignal } from 'solid-js';
import { layoutMenu, titleOf, toolbarMenu, toolbarPanels } from '@/layout/panelMenu';
import { panelIdentity, sectionOf } from '@/panels/titles';
import { layoutPanelIds, openPanel } from '@/state/layout';
import { liveUpdates, reconnectDiscord } from '@/state/liveUpdates';
import { privacyMode, togglePrivacyMode } from '@/state/privacy';
import { unreadCount } from '@/state/unread';
import { openContextMenu, setSettingsOpen } from '@/state/ui';
import { EyeIcon } from '@/ui/EyeIcon';
import { TopBarButton } from './TopBarButton';
import { SectionIcon } from '@/ui/SectionIcon';
import { Search } from './Search';
import { Icon } from '@/ui/icons';
import { HeaderButton } from '@/ui/PanelHeader';
import { look } from '@/theme/look';
import styles from './TopBar.module.css';
import { topBarItems } from '@/plugins/slots';
import type { TopBarItem } from '@/plugins/frameSlots';
import type { HostTopBarItemId } from '@shared/anchors';

/**
 * One button per panel: click opens it (in its own window, or shows it where the layout has it); right-click places it in
 * the layout. A dot marks unseen items (see state/unread).
 */
function PanelToolbar() {
  return (
    <nav class={styles.toolbar} aria-label="Panels">
      <For each={toolbarPanels()}>
        {(id) => {
          const section = sectionOf(id);
          const unread = (): string => (unreadCount(id) > 0 ? ` (${unreadCount(id)} new)` : '');
          return (
            <button
              type="button"
              class={styles.panelButton}
              {...panelIdentity(id)}
              data-placed={layoutPanelIds().includes(id)}
              aria-label={`${titleOf(id)}${unread()}: open`}
              title={`${titleOf(id)}${unread()}: click to open, right-click to place it in the layout`}
              onClick={() => openPanel(id)}
              onContextMenu={(e) => openContextMenu(e, toolbarMenu(id))}
            >
              <SectionIcon section={section} />
              <Show when={unreadCount(id) > 0}>
                <span class={styles.badgeDot} aria-hidden="true" />
              </Show>
            </button>
          );
        }}
      </For>
    </nav>
  );
}

/** The layout's menu: add a panel that isn't shown (then point at its spot), or reset to the default layout. */
function LayoutButton() {
  return (
    <button type="button" class={styles.iconButton} aria-label="Layout" aria-haspopup="menu" title="Layout: add a panel or reset the layout"
      onClick={(e) => openContextMenu(e, layoutMenu())}>
      <Icon name="apps" class={styles.icon} />
    </button>
  );
}

/** While Discord's live traffic doesn't reach ChattyPop: nothing new arrives until Reconnect reloads the client. */
function LiveUpdatesWarning() {
  const [reconnecting, setReconnecting] = createSignal(false);
  const reconnect = (): void => {
    setReconnecting(true);
    // A failed call (main logs its own) leaves the state off, so the warning and its button stay.
    void reconnectDiscord().catch(() => undefined).finally(() => setReconnecting(false));
  };
  return (
    <Show when={liveUpdates() === 'off'}>
      <div role="status" class={`${styles.liveWarning} ${look.status}`} data-tint="danger"
        title="ChattyPop isn't receiving Discord's live traffic: new messages, DMs and alerts won't appear until it reconnects.">
        <Icon name="alert" class={styles.liveWarningIcon} />
        <span>Live updates off</span>
        <HeaderButton disabled={reconnecting()} onClick={reconnect}>Reconnect</HeaderButton>
      </div>
    </Show>
  );
}

/** Host PrivacyButton: retained markup, placed alongside plugin contributions. */
function PrivacyButton() {
  return (
    <TopBarButton
      label="Privacy mode"
      pressed={privacyMode()}
      title={privacyMode() ? 'Privacy mode on: private servers and channels are hidden. Click to show them.' : 'Hide private servers and channels (mark them by right-clicking)'}
      onClick={togglePrivacyMode}
      icon={(iconClass) => <EyeIcon class={iconClass} crossed={privacyMode()} />}
    />
  );
}

/** Host SettingsButton: retained markup, placed alongside plugin contributions. */
function SettingsButton() {
  return (
    <TopBarButton
      label="Settings"
      onClick={() => setSettingsOpen(true)}
      icon={(iconClass) => (
        <Icon name="settings" class={iconClass} />
      )}
    />
  );
}

const HOST_ITEMS: readonly (TopBarItem & { id: HostTopBarItemId })[] = [
  {
    id: 'layout',
    Component: LayoutButton,
  },
  {
    id: 'privacy',
    Component: PrivacyButton,
  },
  {
    id: 'settings',
    Component: SettingsButton,
  },
];

/** Fixed app frame contains search, panel toolbar, a live-updates warning, the layout menu, privacy, settings and plugin items. Window title names app; status bar shows version. */
export function TopBar() {
  return (
    <header class={styles.root}>
      <div class={styles.start}>
        <Search />
      </div>
      <PanelToolbar />
      <div class={styles.end}>
        <LiveUpdatesWarning />
        <For each={topBarItems(HOST_ITEMS)}>{(item) => <item.Component />}</For>
      </div>
    </header>
  );
}
