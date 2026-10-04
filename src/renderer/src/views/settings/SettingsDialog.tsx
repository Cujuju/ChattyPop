// Host settings dialog.
import { For, Show, createEffect, createMemo, on } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { RULES_SECTION, mayLeaveRulePage } from '@/state/rules';
import type { HostSettingsTabId } from '@shared/anchors';
import { withPluginTabs, type SettingsTab } from '@/plugins/slots';
import { setSettingsOpen, setSettingsSection, setSettingsTab, settingsOpen, settingsSection, settingsTab } from '@/state/ui';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { ICON_SHAPES } from '@/ui/icons';
import { SECTION_ICON_PATHS } from '@/ui/SectionIcon';
import { AiSection } from './AiSection';
import { AppearanceSection } from './AppearanceSection';
import { ArchiveSection } from './ArchiveSection';
import { DesktopSection } from './DesktopSection';
import { JevSection } from './JevSection';
import { NotificationsSection } from './NotificationsSection';
import { PluginsSection } from './PluginsSection';
import { RulesSection } from './rules/RulesSection';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './SettingsDialog.module.css';

type Tab = SettingsTab;
/** A host tab: plugin tabs may anchor on its id. */
type HostTab = Tab & { id: HostSettingsTabId };

// Most-tuned first: what the app does (rules and plugins), what powers it (AI, Jev), where messages come from,
// then how it reaches you and looks. Plugins add theirs (Transcription after Archive, Phone after Notifications).
const TABS: readonly [HostTab, ...HostTab[]] = [
  {
    id: RULES_SECTION,
    label: 'Rules',
    // A lightning bolt: an event sets them off.
    icon: () => <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
    body: RulesSection,
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: SECTION_ICON_PATHS.plugin,
    body: PluginsSection,
  },
  {
    id: 'ai',
    groupStart: true,
    label: 'AI',
    icon: () => <path d="M11 3.5 12.8 8.2 17.5 10 12.8 11.8 11 16.5 9.2 11.8 4.5 10 9.2 8.2z M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
    body: AiSection,
  },
  {
    id: 'jev',
    label: 'Jev',
    // Jev's mark, as its menu items show it.
    icon: ICON_SHAPES.jev,
    body: JevSection,
  },
  {
    id: 'archive',
    groupStart: true,
    label: 'Archive',
    icon: SECTION_ICON_PATHS.channels,
    body: ArchiveSection,
  },
  {
    id: 'notifications',
    groupStart: true,
    label: 'Notifications',
    // A bell.
    icon: () => <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0" />,
    body: NotificationsSection,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    // A monitor on its stand.
    icon: () => <path d="M3.5 5h17v11h-17zM9 20h6M12 16v4" />,
    body: DesktopSection,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: () => (
      <>
        <path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.3-4-7.8-9-7.8z" />
        {/* Filled paint dots: stroked, they are 2px rings at tab size. */}
        <circle cx="7.5" cy="11.5" r="1.25" fill="currentColor" />
        <circle cx="10" cy="7.5" r="1.25" fill="currentColor" />
        <circle cx="15" cy="7.5" r="1.25" fill="currentColor" />
      </>
    ),
    body: AppearanceSection,
  },
];

/** Settings in a floating window (draggable, resizable, non-modal; Esc closes); a vertical tab list picks the section shown. */
export function SettingsDialog() {
  let panel!: HTMLDivElement;
  const tabs = createMemo(() => withPluginTabs(TABS));
  /** The chosen tab (restored on start), or the first while it is gone or its plugin is off. */
  const active = createMemo<Tab>(() => tabs().find((tab) => tab.id === settingsTab()) ?? TABS[0]);
  const buttons = new Map<string, HTMLButtonElement>();
  /** Leaving the Rules page (another tab, or closing) first asks about a rule's unsaved edits. */
  const mayLeave = (): boolean => active().id !== RULES_SECTION || mayLeaveRulePage();
  const setActive = (tab: Tab): boolean => {
    if (tab.id === active().id) return true;
    if (!mayLeave()) return false;
    void setSettingsTab(tab.id);
    return true;
  };
  const close = (): void => {
    if (mayLeave()) setSettingsOpen(false);
  };
  // Each section starts at its top, not at the previous section's scroll offset.
  createEffect(on(active, () => panel.scrollTo({ top: 0 }), { defer: true }));
  createEffect(() => {
    const tab = tabs().find((t) => t.id === settingsSection());
    if (!tab) return;
    setActive(tab);
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
    if (setActive(next)) buttons.get(next.id)?.focus();
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
                  onClick={() => setActive(tab)}
                >
                  <svg class={styles.tabIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    {tab.icon()}
                  </svg>
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
