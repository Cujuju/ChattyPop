// The phone's host slots (docs/plugin-architecture.md §3): its sections and drawer panes, host items first, for the
// phone transport's page to show; plugins place theirs among them.
import type { HostPhoneDrawerItemId, HostPhoneSectionId } from '@shared/anchors';
import { ArchiveView } from '@/panels/chat/ArchiveView';
import { ChannelsPanel } from '@/panels/channels';
import { archiveChannelId } from '@/state/archive';
import { channelById, channelLabel } from '@/state/directory';
import { PanelHeader } from '@/ui/PanelHeader';
import { adoptedPhoneSection } from '@shared/bundledPlugins';
import { phoneOverview } from '@/plugins/featureWording';
import { notificationKinds, phoneDrawerItems, phoneSections } from '@/plugins/slots';
import { phoneSectionOf, type NotificationKind, type PhoneDrawerItem, type PhoneSection } from '@/plugins/frameSlots';

/** The Archive on its own: the desktop's Chat panel without the live Discord client; its header names the open channel. */
const ArchivePane = () => {
  const channel = () => {
    const id = archiveChannelId();
    return id ? channelById(id) : undefined;
  };
  return (
    // Structural geometry only: the Archive takes all the height under its header.
    <section class="cp-panel" aria-label="Archive" style={{ display: 'grid', 'grid-template-rows': 'auto minmax(0, 1fr)' }}>
      {/* Every phone section has a header: the phone's bar lies over its first line. */}
      <PanelHeader section="chat" title={channel() ? channelLabel(channel()!) : 'Archive'} />
      <ArchiveView />
    </section>
  );
};

const HOST_SECTIONS: readonly (PhoneSection & { id: HostPhoneSectionId })[] = [
  {
    id: 'archive',
    label: 'Archive',
    section: 'chat',
    Component: ArchivePane,
  },
];

/** A channel row in the Channels panel (its documented hook, Channels.module.css). */
const CHANNEL_ROW = 'section[aria-label="Channels"] button[aria-current]';

/** The host's drawer panes. */
const HOST_DRAWER_ITEMS: readonly (PhoneDrawerItem & { id: HostPhoneDrawerItemId })[] = [
  { id: 'channels', label: 'channels', section: 'channels', Component: ChannelsPanel, opensArchive: CHANNEL_ROW },
];

/** The phone's sections: the Archive and active plugins' sections, in placement order. Reactive. */
export const phoneTabs = (): PhoneSection[] => phoneSections(HOST_SECTIONS);

/** The section a phone's stored section id or notice target opens (phoneSectionOf), or null. Reactive. */
export const phoneSectionFor = (id: string): string | null => phoneSectionOf(id, phoneTabs(), adoptedPhoneSection);

/** The phone drawer's panes: the host's and active plugins', in placement order. Reactive. */
export const phoneDrawerPanes = (): PhoneDrawerItem[] => phoneDrawerItems(HOST_DRAWER_ITEMS);

/** What the phone offers, from active section descriptions in drawer order; the transport adds how it is reached. Reactive. */
export const phoneOverviewText = (): string => phoneOverview(phoneTabs().flatMap((section) => section.overview ?? []));

/** The phone's notice choices: the host's and active plugins' kinds, in placement order. Reactive. */
export const phoneNoticeKinds = (): NotificationKind[] => notificationKinds();
