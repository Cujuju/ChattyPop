// Reactive frame contributions and shared placement, independent of renderer startup.
import type { NoticeKind } from '@shared/notices';
import type { Component } from 'solid-js';
import { placeByAnchor, placementAnchor, type PlacementAnchor } from '@shared/anchors';
import { stampedName, type PluginDescriptor } from '@shared/bundledTypes';
import type { SlotKind } from '@shared/slots';
import type { SectionId } from '../panels/titles';
import type { ProviderId } from '@shared/settings';
import type { UnreadSource } from '@shared/unread';
import { declaredItems, placeSlot, type SlotAnchorOf, type SlotItem } from './slotItems';

/** A component in the top bar's end group. */
export interface TopBarView {
  Component: Component;
}

/** A component in the app status bar. */
export interface StatusBarView {
  Component: Component;
}

/** Where the phone offers a section: a drawer row, or a top-bar button showing its badge (an inbox checked often). */
export type PhoneSectionPlace = 'drawer' | 'bar';

/** A companion pane and its entry (drawer or top bar), with its theme scope and optional numeric badge. */
export interface PhoneSectionView {
  label: string;
  /** The desktop panel it presents: its theme scope (section colour, importance), and where a notice naming that panel opens. */
  section: SectionId;
  Component: Component;
  badge?: () => number;
  /** Default 'drawer'. */
  place?: PhoneSectionPlace;
  /** Content and optional action described on the Phone settings page. */
  overview?: {
    noun: string;
    does?: string;
  };
}

/** A pane in the companion drawer, below its section list. */
export interface PhoneDrawerView {
  /** Lowercase noun for the drawer's accessible name ("Sections, channels and …"). */
  label: string;
  /** Theme scope (section colour and icon) of the pane. */
  section: SectionId;
  Component: Component;
  /** Elements in the pane that open a channel in the Archive: a click on one closes the drawer and shows the Archive. */
  opensArchive?: string;
}

/** A row in every running provider's card in Settings → AI (HOST_PROVIDER_ROWS anchors), for provider `provider`. */
export interface ProviderRowView {
  Component: Component<{ provider: ProviderId }>;
}

export type TopBarItem = SlotItem<TopBarView>;
export type StatusBarContribution = SlotItem<StatusBarView>;
export type PhoneSection = SlotItem<PhoneSectionView>;
export type PhoneDrawerItem = SlotItem<PhoneDrawerView>;
export type ProviderRow = SlotItem<ProviderRowView>;

/** Resolves section ids, adopted legacy ids or panel ids presented by sections. Returns null when unmatched. */
export function phoneSectionOf(id: string, sections: readonly PhoneSection[], adopted: (old: string) => string | undefined): string | null {
  const current = adopted(id) ?? id;
  return (sections.find((s) => s.id === current) ?? sections.find((s) => s.section === id))?.id ?? null;
}
/** A plugin's notice kind as it contributes it: keyed by its declared kind, which the host stamps into `id`; placed by its declaration. */
export type NotificationKindView = {
  label: string;
  /** Settings → Notifications: what the desktop switch covers, a lede sentence and the switch's hint. */
  desktop?: {
    subject: string;
    note?: string;
    hint?: string;
  };
};
/** A kind of notice: a choice in the paired phone's preferences, and how Settings → Notifications describes it. */
export type NotificationKind = NotificationKindView & { id: NoticeKind };

/** Host notice kinds; feature-owned kinds are contributed by their plugins. */
export const HOST_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  { id: 'plugin', label: 'Plugin notifications' },
];

/** Views by local id for the items a descriptor declares in its frame slots, read only while their owner is active. */
export interface FrameContributions {
  statusBar?: Readonly<Record<string, StatusBarView>>;
  topBar?: Readonly<Record<string, TopBarView>>;
  phoneSections?: Readonly<Record<string, PhoneSectionView>>;
  phoneDrawer?: Readonly<Record<string, PhoneDrawerView>>;
  providerRows?: Readonly<Record<string, ProviderRowView>>;
  notificationKinds?: Readonly<Record<string, NotificationKindView>>;
  unread?: Readonly<Record<string, UnreadSource>>;
}

/** A descriptor paired with its frame contributions. */
export interface FrameSlotEntry {
  plugin: PluginDescriptor;
  contributions: FrameContributions;
}

/**
 * Places active plugins' items among the host's by the catalog's anchors (`anchorOf`, `noticeAnchorOf`), so a disabled
 * or absent anchor keeps its place.
 */
export function frameSlots(
  entries: () => readonly FrameSlotEntry[],
  enabled: (id: string) => boolean,
  anchorOf: SlotAnchorOf,
  noticeAnchorOf: (kind: string) => PlacementAnchor | undefined,
) {
  const active = () => entries().filter((entry) => enabled(entry.plugin.manifest.id));
  const place = <V extends object>(kind: SlotKind & keyof FrameContributions, host: readonly SlotItem<V>[]): SlotItem<V>[] =>
    placeSlot(kind, host, declaredItems(active(), kind, (entry) => entry.contributions[kind] as Readonly<Record<string, V>> | undefined), anchorOf);
  /** An entry's notice kinds, each stamped `<plugin id>.<kind>`. */
  const kindsOf = (entry: FrameSlotEntry): NotificationKind[] =>
    Object.entries(entry.contributions.notificationKinds ?? {}).map(([kind, view]): NotificationKind => ({ ...view, id: stampedName(entry.plugin.manifest.id, kind) }));
  /** Notice kinds are placed as their descriptors declare (`notices`, checkBundled), read from the catalog. */
  const noticeKinds = (host: readonly NotificationKind[]): NotificationKind[] => {
    const extra = active().flatMap(kindsOf);
    if (new Set([...host, ...extra].map((kind) => kind.id)).size !== host.length + extra.length) throw new Error('Duplicate notice kind');
    return placeByAnchor<NotificationKind>(host, extra, (kind) => kind.id, noticeAnchorOf);
  };
  return {
    statusBar: (host: readonly StatusBarContribution[]) => place('statusBar', host),
    topBar: (host: readonly TopBarItem[]) => place('topBar', host),
    phone: (host: readonly PhoneSection[]) => place('phoneSections', host),
    phoneDrawer: (host: readonly PhoneDrawerItem[]) => place('phoneDrawer', host),
    notificationKinds: noticeKinds,
    providerRows: (host: readonly ProviderRow[]) => place('providerRows', host),
    unread: () => active().flatMap((entry) => Object.entries(entry.contributions.unread ?? {})),
  };
}
