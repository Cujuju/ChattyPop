// The phone's Settings: the desktop dialog's sections (views/settings/tabs.tsx) as an iOS list; a row opens its section under a back button.
import { For, Show, createEffect, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { SectionId } from '@/panels/titles';
import { setSettingsSection, settingsSection } from '@/state/ui';
import { look } from '@/theme/look';
import { Icon } from '@/ui/icons';
import { PanelHeader } from '@/ui/PanelHeader';
import { SettingsTabIcon, mayLeaveSettingsTab, settingsTabGroups, settingsTabs } from '@/views/settings/tabs';
import styles from './PhoneSettings.module.css';

/** The desktop's Settings sections, a card per group (the dialog's dividers): icon, name and a chevron per row. */
export function PhoneSettingsList(props: { onOpen: (id: string) => void }) {
  return (
    <div class={styles.list}>
      <For each={settingsTabGroups()}>
        {(group) => (
          <ul class={`${styles.card} ${look.card}`}>
            <For each={group}>
              {(tab) => (
                <li class={styles.item}>
                  <button type="button" class={`${styles.row} ${look.row} ${look.text}`} data-press data-size="lg" onClick={() => props.onOpen(tab.id)}>
                    <span class={styles.tile}>
                      <SettingsTabIcon tab={tab} class={styles.tileIcon} />
                    </span>
                    <span class={styles.label}>{tab.label}</span>
                    <Icon name="chevronRight" class={`${styles.chevron} ${look.lineIcon}`} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </For>
    </div>
  );
}

/**
 * A Settings pane: its header and one scrolling body. With no section `open`, the body is `children` (the shell's own
 * groups, PhoneSettingsList among them); with one, that section's body, and a back button before its title.
 */
export function PhoneSettings(props: {
  /** The pane's theme section: its header's colour. */
  section: SectionId;
  /** The top level's title, and the back button's destination. */
  title: string;
  /** The open section's id; null, or a section no longer offered, shows the top level. */
  open: string | null;
  onOpen: (id: string | null) => void;
  children: JSX.Element;
}) {
  const tab = () => settingsTabs().find((t) => t.id === props.open);
  /** Leaves the open section unless it keeps unsaved edits (Rules asks). */
  const mayLeave = (): boolean => !props.open || mayLeaveSettingsTab(props.open);
  const back = (): void => {
    if (mayLeave()) props.onOpen(null);
  };
  // A section asked for elsewhere (openSettingsAt, as the dialog takes it) opens here.
  createEffect(() => {
    const id = settingsSection();
    if (!id || !settingsTabs().some((t) => t.id === id)) return;
    setSettingsSection(null);
    if (id !== props.open && mayLeave()) props.onOpen(id);
  });

  return (
    <section class="cp-panel" aria-label={tab()?.label ?? props.title}>
      <PanelHeader
        section={props.section}
        title={tab()?.label ?? props.title}
        lead={
          <Show when={tab()}>
            <button type="button" class={`${styles.back} ${look.iconButton}`} aria-label={`Back to ${props.title}`} onClick={back}>
              <Icon name="chevronLeft" class={`${styles.backIcon} ${look.lineIcon}`} />
            </button>
          </Show>
        }
      />
      {/* Kept mounted: the shell's own choices keep their state while a section is open. */}
      <div class={`cp-panel-body ${styles.body} ${styles.top}`} hidden={!!tab()}>
        {props.children}
      </div>
      {/* Keyed: each section opens fresh, at its top. */}
      <Show when={tab()} keyed>
        {(t) => (
          <div class={`cp-panel-body ${styles.body} ${styles.section}`}>
            <Dynamic component={t.body} />
          </div>
        )}
      </Show>
    </section>
  );
}
