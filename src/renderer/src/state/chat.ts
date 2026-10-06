import { api } from '@/api';
import { createSignal, onCleanup, createEffect, type Accessor } from 'solid-js';
import {
  DEFAULT_CHAT_SOURCE,
  DEFAULT_DISCORD_SIDEBAR,
  SETTINGS_KEYS,
  normalizeChatSource,
  normalizeDiscordSidebar,
  type ChatSource,
  type DiscordSidebar,
} from '@shared/settings';
import { listen } from '@/ui/listen';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { inCompanion } from './ui';
import { windowsCover } from './windows';

export type { ChatSource };

/** Which source the chat panel shows, restored on start. The phone has no live client, only the Archive, and stores nothing. */
export const [chatSource, setChatSource]: readonly [Accessor<ChatSource>, (v: ChatSource) => unknown, ...unknown[]] = inCompanion
  ? createSignal<ChatSource>('archive')
  : createSetting<ChatSource>(SETTINGS_KEYS.chatSource, DEFAULT_CHAT_SOURCE, normalizeChatSource);

/** Live client columns hidden or collapsed; applied to the Discord page by main while a slot is bound. */
export const [discordSidebar, setDiscordSidebar] = createSetting<DiscordSidebar>(SETTINGS_KEYS.discordSidebar, DEFAULT_DISCORD_SIDEBAR, normalizeDiscordSidebar);

/** Tracks element geometry for native Discord placement. Hides view when invisible, element-hidden or unmounted. */
export function bindDiscordSlot(el: HTMLElement, visible: Accessor<boolean>): void {
  const report = (): void => {
    const r = el.getBoundingClientRect();
    api.discord.setSlot({ visible: visible() && el.isConnected && !windowsCover(r), x: r.left, y: r.top, width: r.width, height: r.height });
  };
  // The slot moves when any ancestor resizes (splits, tab switches, window), so observe the whole chain.
  const observer = new ResizeObserver(report);
  for (let n: HTMLElement | null = el; n; n = n.parentElement) observer.observe(n);
  listen(window, 'resize', report);
  createEffect(report);
  createEffect(() => api.discord.setSidebar(discordSidebar()));
  onCleanup(() => {
    observer.disconnect();
    api.discord.setSlot({ visible: false, x: 0, y: 0, width: 0, height: 0 });
  });
}
