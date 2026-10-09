// The message slots (docs/plugin-architecture.md §3): the Archive view's footer and a hovered message's bar, placed
// independent of renderer startup.
import type { Component } from 'solid-js';
import { HOST_HOVER_ACTIONS, type HostChatFooterItemId, type HostHoverActionId, type HostHoverEmojiItemId } from '@shared/anchors';
import type { ArchiveAttachment, ArchiveMessage, DirectoryChannel } from '@shared/contract';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { declaredItems, placeSlot, type SlotAnchorOf, type SlotItem } from './slotItems';

/** What a footer item renders for: the channel the Archive view shows, when it takes posts. */
export interface ChatFooterProps {
  channel: DirectoryChannel;
  /** Reports the item's root when it lies over the log's bottom: the log ends that far above it (the tallest, if several). */
  measure(el: HTMLElement): void;
}

/** An item under the Archive view's log (the message box). */
export interface ChatFooterView {
  Component: Component<ChatFooterProps>;
}

/** Buttons in a hovered message's bar, for that message; drawn with the kit's HoverBarButton so they look alike. */
export interface HoverBarView {
  Component: Component<{ message: ArchiveMessage }>;
}

/** Deprecated (SDK 2.34; removed at 3): the attachment hover bar is gone, so these draw nowhere; use attachmentMenu. */
export interface AttachmentBarView {
  Component: Component<{ message: ArchiveMessage; attachment: ArchiveAttachment }>;
}

/** Views by local id for the items a descriptor declares in the message slots, read only while their owner is active. */
export interface MessageContributions {
  chatFooter?: Readonly<Record<string, ChatFooterView>>;
  hoverEmoji?: Readonly<Record<string, HoverBarView>>;
  hoverActions?: Readonly<Record<string, HoverBarView>>;
  attachmentActions?: Readonly<Record<string, AttachmentBarView>>;
}

/** The host's own items, fixed anchors whatever they render (an action hidden for a message renders nothing). */
export type HostChatFooterItem = SlotItem<ChatFooterView> & { id: HostChatFooterItemId };
export type HostHoverEmojiItem = SlotItem<HoverBarView> & { id: HostHoverEmojiItemId };
export type HostHoverAction = SlotItem<HoverBarView> & { id: HostHoverActionId };

/** The host's hover actions: anchors only, drawing nothing; a posting plugin places its Edit, Reply and Forward at them. */
export const HOST_HOVER_ACTION_ANCHORS: readonly HostHoverAction[] = HOST_HOVER_ACTIONS.map((id) => ({ id, Component: () => null }));
/** A descriptor paired with its message-slot contributions. */
export interface MessageSlotEntry {
  plugin: PluginDescriptor;
  contributions: MessageContributions;
}

/** Places active plugins' items among the host's by the catalog's anchors (`anchorOf`). Reactive reads. */
export function messageSlots(entries: () => readonly MessageSlotEntry[], enabled: (id: string) => boolean, anchorOf: SlotAnchorOf) {
  const active = () => entries().filter((entry) => enabled(entry.plugin.manifest.id));
  const place = <V extends object>(kind: keyof MessageContributions, host: readonly SlotItem<V>[]): SlotItem<V>[] =>
    placeSlot(kind, host, declaredItems(active(), kind, (entry) => entry.contributions[kind] as Readonly<Record<string, V>> | undefined), anchorOf);
  return {
    chatFooter: (host: readonly SlotItem<ChatFooterView>[]) => place('chatFooter', host),
    hoverEmoji: (host: readonly SlotItem<HoverBarView>[]) => place('hoverEmoji', host),
    hoverActions: (host: readonly SlotItem<HoverBarView>[]) => place('hoverActions', host),
  };
}
