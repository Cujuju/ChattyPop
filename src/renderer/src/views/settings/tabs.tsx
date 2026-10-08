// Settings' sections, one list for the desktop dialog and the phone: the host's tabs with plugin tabs placed among them.
import { RULES_SECTION, mayLeaveRulePage } from '@/state/rules';
import type { HostSettingsTabId } from '@shared/anchors';
import { withPluginTabs, type SettingsTab } from '@/plugins/slots';
import { ICON_SHAPES } from '@/ui/icons';
import { SECTION_ICON_PATHS } from '@/ui/SectionIcon';
import { AiSection } from './AiSection';
import { AppearanceSection } from './AppearanceSection';
import { ArchiveSection } from './ArchiveSection';
import { ChatSection } from './ChatSection';
import { DesktopSection } from './DesktopSection';
import { JevSection } from './JevSection';
import { NotificationsSection } from './NotificationsSection';
import { PluginsSection } from './PluginsSection';
import { RulesSection } from './rules/RulesSection';

/** A host tab: plugin tabs may anchor on its id. */
type HostTab = SettingsTab & { id: HostSettingsTabId };

// Orders rules/plugins, AI/Jev, message sources, notifications and appearance. Plugin sections use declared anchors.
export const HOST_SETTINGS_TABS: readonly [HostTab, ...HostTab[]] = [
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
    label: 'AI providers',
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
    id: 'chat',
    groupStart: true,
    label: 'Chat',
    // A speech bubble.
    icon: () => <path d="M4 5h16v11H9l-5 4z" />,
    body: ChatSection,
  },
  {
    id: 'notifications',
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

/** Every Settings section in order: the host's and active plugins'. Reactive. */
export const settingsTabs = (): SettingsTab[] => withPluginTabs(HOST_SETTINGS_TABS);

/** The sections split where a group starts (groupStart): the dialog's dividers, the phone's cards. Reactive. */
export function settingsTabGroups(): SettingsTab[][] {
  const groups: SettingsTab[][] = [];
  for (const tab of settingsTabs()) {
    if (tab.groupStart || !groups.length) groups.push([]);
    groups.at(-1)!.push(tab);
  }
  return groups;
}

/** Whether section `id` may be left: leaving Rules first asks about a rule's unsaved edits. */
export const mayLeaveSettingsTab = (id: string): Promise<boolean> => (id === RULES_SECTION ? mayLeaveRulePage() : Promise.resolve(true));

/** A section's 24-unit line icon; its size and colour come from `class`. */
export const SettingsTabIcon = (props: { tab: SettingsTab; class?: string }) => (
  <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {props.tab.icon()}
  </svg>
);
