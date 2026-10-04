import { For, Show } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { layoutMenu, panelDragProps, titleOf, toolbarPanels } from '@/layout/panelMenu';
import { PRESETS, type PresetId } from '@/layout/presets';
import { panelIds } from '@/layout/tree';
import type { LayoutPanelId } from '@/layout/types';
import { panelIdentity, sectionOf } from '@/panels/titles';
import {
  currentLayout,
  customLayouts,
  LAYOUT_NAME_MAX,
  layoutId,
  openPanel,
  renameCustomLayout,
  renamingLayout,
  setLayoutId,
  setRenamingLayout,
  type LayoutId,
} from '@/state/layout';
import { privacyMode, togglePrivacyMode } from '@/state/privacy';
import { unreadCount } from '@/state/unread';
import { openContextMenu, setSettingsOpen } from '@/state/ui';
import { EyeIcon } from '@/ui/EyeIcon';
import { TopBarButton } from './TopBarButton';
import { SectionIcon } from '@/ui/SectionIcon';
import { Search } from './Search';
import { Icon } from '@/ui/icons';
import styles from './TopBar.module.css';
import { topBarItems } from '@/plugins/slots';
import type { TopBarItem } from '@/plugins/frameSlots';
import type { HostTopBarItemId } from '@shared/anchors';

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/**
 * One button per panel: click opens it in its own window; drag onto a panel's edge or middle places it in the layout.
 * A dot marks unseen items (see state/unread).
 */
function PanelToolbar() {
  const placed = (): LayoutPanelId[] => panelIds(currentLayout().root);
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
              data-placed={placed().includes(id)}
              aria-label={`${titleOf(id)}${unread()}: open in a window`}
              title={`${titleOf(id)}${unread()}: click to open in a window, drag onto a panel to place it`}
              {...panelDragProps(() => id)}
              onClick={() => openPanel(id)}
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

/** Edits a custom layout's name in place of the switcher: Enter or leaving the field saves, Esc cancels. */
function LayoutNameInput(props: { id: LayoutId }) {
  let done = false;
  const finish = (name: string | null): void => {
    if (done) return;
    done = true;
    if (name !== null) renameCustomLayout(props.id, name);
    setRenamingLayout(null);
  };
  return (
    <input
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      type="text"
      aria-label="Layout name"
      maxLength={LAYOUT_NAME_MAX}
      value={customLayouts()[props.id]?.name ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** Presets, then custom layouts. Right-click renames or deletes the current custom layout. */
function LayoutSwitcher() {
  const openMenu = (e: MouseEvent): void => openContextMenu(e, layoutMenu());
  return (
    <Show
      when={renamingLayout()}
      fallback={
        <div onContextMenu={openMenu}>
          <SegGroup class="cp-stroke" role="radiogroup" ariaLabel="Panel layout" value={layoutId()} onChange={(v: string) => setLayoutId(v)}>
            <For each={PRESET_IDS}>{(id) => <SegButton value={id} label={PRESETS[id].name} size="sm" />}</For>
            <For each={Object.entries(customLayouts())}>{([id, doc]) => <SegButton value={id} label={doc.name} size="sm" />}</For>
          </SegGroup>
        </div>
      }
    >
      {(id) => <LayoutNameInput id={id()} />}
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
    Component: LayoutSwitcher,
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

/**
 * App frame: archive search, the panel toolbar (centred), layout switcher, privacy mode, settings and plugin items. Not a panel, so
 * layouts never move it. The name is in the window title; the version is in the status bar.
 */
export function TopBar() {
  return (
    <header class={styles.root}>
      <div class={styles.start}>
        <Search />
      </div>
      <PanelToolbar />
      <div class={styles.end}>
        <For each={topBarItems(HOST_ITEMS)}>{(item) => <item.Component />}</For>
      </div>
    </header>
  );
}
