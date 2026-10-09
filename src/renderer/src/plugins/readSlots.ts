// Read-only contribution slots independent of renderer startup, for contract testing and reactive host reads.
import { type HostAttachmentMenuItemId, type HostMessageMenuGroupId } from '@shared/anchors';
import type { ArchiveAttachment, ArchiveMessage, DirectoryChannel } from '@shared/contract';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { Component } from 'solid-js';
import type { MenuGroup, MenuItem } from '../ui/menuTypes';
import { declaredItems, placeSlot, type SlotAnchorOf } from './slotItems';

/** Parts of a message drawn by the row opening its menu. */
export interface MessageMenuScope {
  drawsAttachments: boolean;
}

/** Menu actions of a plugin: shown only in windows that may make every core call they make (a phone may not). */
export interface MenuActions {
  /** The plugin's core calls its items make, directly or through what they open. */
  calls: readonly string[];
}

/** A group of a message's right-click menu, with an optional heading. */
export type MessageMenuView = MenuActions & {
  heading?: string;
  menu(message: ArchiveMessage, scope: MessageMenuScope): MenuItem[];
};

/** An item of a pressed attachment's group in its message's menu; null for an attachment it doesn't apply to. */
export type AttachmentMenuView = MenuActions & {
  item(message: ArchiveMessage, attachment: ArchiveAttachment): MenuItem | null;
};

/** A host item of that group, at its anchor; null where it doesn't apply (the anchors modify and delete, always). */
export interface HostAttachmentMenuItem {
  id: HostAttachmentMenuItemId;
  item(message: ArchiveMessage, attachment: ArchiveAttachment): MenuItem | null;
}

/** A section after a person's channels. */
export interface PersonSectionView {
  Component: Component<{ userId: string }>;
}

/** A person's links, drawn in place of the host's plain list of them. */
export interface PersonLinksView {
  Component: Component<{ userId: string }>;
}

/** Read contributions consumed by archive, person and search slots; slot views keyed by their declared local ids. */
export interface ReadContributions {
  personSections?: Readonly<Record<string, PersonSectionView>>;
  personLinks?: Readonly<Record<string, PersonLinksView>>;
  channels?: MenuActions & { jevItems(channel: DirectoryChannel): MenuItem[] };
  messageMenu?: Readonly<Record<string, MessageMenuView>>;
  attachmentMenu?: Readonly<Record<string, AttachmentMenuView>>;
}

/** A fixed host group, retained as an anchor even when empty. */
export type HostMessageMenuGroup = MenuGroup & { id: HostMessageMenuGroupId };

/** A descriptor paired with its renderer contributions. */
export interface ReadSlotEntry {
  plugin: PluginDescriptor;
  contributions: ReadContributions;
}

/** Reads activity in caller reactive scope. mayCall checks enabled audience access; menus require all calls available. anchorOf resolves stamped catalog placement. */
export function readSlots(
  entries: () => readonly ReadSlotEntry[],
  enabled: (id: string) => boolean,
  mayCall: (pluginId: string, name: string) => boolean,
  anchorOf: SlotAnchorOf,
) {
  const active = () => entries().filter((entry) => enabled(entry.plugin.manifest.id));
  const actionable = (entry: ReadSlotEntry, actions: MenuActions | undefined): boolean =>
    !!actions && actions.calls.every((name) => mayCall(entry.plugin.manifest.id, name));
  /** `entry`'s views in `kind` it may offer: those whose calls this window may make. */
  const offered = <V extends MenuActions>(entry: ReadSlotEntry, views: Readonly<Record<string, V>> | undefined) =>
    Object.fromEntries(Object.entries(views ?? {}).filter(([, view]) => actionable(entry, view)));
  return {
    people: () => placeSlot('personSections', [], declaredItems(active(), 'personSections', (entry) => entry.contributions.personSections), anchorOf),
    /** The view of a person's links: the first placed item of an active plugin; null when none (the host lists them plainly). */
    personLinks: (): PersonLinksView | null =>
      placeSlot('personLinks', [], declaredItems(active(), 'personLinks', (entry) => entry.contributions.personLinks), anchorOf)[0] ?? null,
    search: () => active().flatMap((entry) => entry.plugin.search?.tokens ?? []),
    channels: (channel: DirectoryChannel) => active().flatMap((entry) => {
      const channels = entry.contributions.channels;
      return channels && actionable(entry, channels) ? channels.jevItems(channel) : [];
    }),
    messages: (message: ArchiveMessage, scope: MessageMenuScope, host: readonly HostMessageMenuGroup[] = []): MenuGroup[] => {
      const extra = declaredItems(active(), 'messageMenu', (entry) => offered(entry, entry.contributions.messageMenu)).map((group) => ({
        id: group.id,
        heading: group.heading,
        items: group.menu(message, scope),
      }));
      return placeSlot<MenuGroup & { id: string }>('messageMenu', host, extra, anchorOf).filter((group) => group.items.length);
    },
    /** The items for `attachment` of `message`: the host's with plugins' placed among them, those that apply. */
    attachments: (message: ArchiveMessage, attachment: ArchiveAttachment, host: readonly HostAttachmentMenuItem[]): MenuItem[] => {
      const extra = declaredItems(active(), 'attachmentMenu', (entry) => offered(entry, entry.contributions.attachmentMenu));
      return placeSlot<{ id: string; item: HostAttachmentMenuItem['item'] }>('attachmentMenu', host, extra, anchorOf).flatMap((i) => i.item(message, attachment) ?? []);
    },
  };
}
