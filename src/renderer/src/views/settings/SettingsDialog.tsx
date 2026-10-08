// Host settings dialog.
import { For, Show, createEffect, createMemo, on } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { SettingsTab } from '@/plugins/slots';
import { setSettingsOpen, setSettingsSection, setSettingsTab, settingsOpen, settingsSection, settingsTab } from '@/state/ui';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { HOST_SETTINGS_TABS, SettingsTabIcon, mayLeaveSettingsTab, settingsTabs } from './tabs';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './SettingsDialog.module.css';

type Tab = SettingsTab;

/** Settings in a floating window (draggable, resizable, non-modal; Esc closes); a vertical tab list picks the section shown. */
export function SettingsDialog() {
  let panel!: HTMLDivElement;
  const tabs = createMemo(settingsTabs);
  /** The chosen tab (restored on start), or the first while it is gone or its plugin is off. */
  const active = createMemo<Tab>(() => tabs().find((tab) => tab.id === settingsTab()) ?? HOST_SETTINGS_TABS[0]);
  const buttons = new Map<string, HTMLButtonElement>();
  /** Leaving the Rules page (another tab, or closing) first asks about a rule's unsaved edits. */
  const mayLeave = (): Promise<boolean> => mayLeaveSettingsTab(active().id);
  const setActive = async (tab: Tab): Promise<boolean> => {
    if (tab.id === active().id) return true;
    if (!(await mayLeave())) return false;
    void setSettingsTab(tab.id);
    return true;
  };
  const close = (): void => void mayLeave().then((ok) => ok && setSettingsOpen(false));
  // Each section starts at its top, not at the previous section's scroll offset.
  createEffect(on(active, () => panel.scrollTo({ top: 0 }), { defer: true }));
  createEffect(() => {
    const tab = tabs().find((t) => t.id === settingsSection());
    if (!tab) return;
    void setActive(tab);
    setSettingsSection(null);
  });

  // WAI-ARIA vertical tabs: arrows wrap, Home/End jump; selection follows focus.
  const onKeyDown = (e: KeyboardEvent): void => {
    const list = tabs();
    const at = list.indexOf(active());
    const last = list.length - 1;
    const index = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at === 0 ? last : at - 1, Home: 0, End: last }[e.key];
    const next = index === undefined ? undefined : list[index];
    if (!next) return;
    e.preventDefault();
    void setActive(next).then((ok) => ok && buttons.get(next.id)?.focus());
  };

  return (
    <FloatingWindow id="settings" open={settingsOpen()} class={`${chrome.dialog} ${styles.dialog}`} aria-labelledby="settings-title" onClose={close}>
      <WindowHeader title="Settings" titleId="settings-title" classes={chrome} closeLabel="Close settings" onClose={close} />
      <div class={styles.main}>
        <nav class={styles.nav} role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onKeyDown}>
          <For each={tabs()}>
            {(tab) => (
              <>
                <Show when={tab.groupStart}>
                  <div class={styles.divider} aria-hidden="true" />
                </Show>
                <button
                  ref={(el) => buttons.set(tab.id, el)}
                  type="button"
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  class={styles.tab}
                  aria-selected={active().id === tab.id}
                  aria-controls="settings-panel"
                  tabIndex={active().id === tab.id ? 0 : -1}
                  onClick={() => void setActive(tab)}
                >
                  <SettingsTabIcon tab={tab} class={styles.tabIcon} />
                  {tab.label}
                </button>
              </>
            )}
          </For>
        </nav>
        <div ref={panel} id="settings-panel" class={chrome.body} role="tabpanel" aria-labelledby={`settings-tab-${active().id}`}>
          <Dynamic component={active().body} />
        </div>
      </div>
    </FloatingWindow>
  );
}
