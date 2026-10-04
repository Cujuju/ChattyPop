import type { DiscordSidebar } from '@shared/settings';

// Discord's hashed class names keep a stable prefix ("sidebar_", "guilds_"); scoped to the app shell so settings pages don't match.
const SIDEBAR = '[class^="base_"] > [class^="content_"] > [class^="sidebar_"]';
const SERVERS = '> nav[class*="guilds_"]';
const CHANNELS = '> [class^="sidebarList_"]';
/** What hides with the channel list: its contents, the user/voice panel, and the width drag handle. */
const CHANNEL_CONTENT = [`${CHANNELS} > *`, '> section[class^="panels_"]', '> [class^="sidebarResizeHandle_"]'];

/** Collapsed channel list keeps this much edge to hover: enough to hit without aiming, little enough to cost no chat width. */
export const HOVER_EDGE_PX = 16;
/** Hover must rest this long before the list opens, so the pointer crossing the edge doesn't reflow the chat. */
export const OPEN_DELAY_MS = 150;
/** The list stays open this long after the pointer leaves, forgiving a brief overshoot. */
export const CLOSE_DELAY_MS = 300;

/** Discord's own width variables: the server column, and the server + channel columns together. */
const SERVERS_W = 'var(--custom-guild-list-width)';
const SIDEBAR_W = 'var(--custom-guild-sidebar-width)';

/** The stylesheet injected into the Discord page for these choices; empty when nothing is hidden. */
export function sidebarCss(s: DiscordSidebar): string {
  const rules: string[] = [];
  if (s.serversHidden) {
    rules.push(`${SIDEBAR} ${SERVERS} { display: none !important; }`);
    rules.push(`${SIDEBAR} { width: calc(${SIDEBAR_W} - ${SERVERS_W}) !important; }`);
  }
  if (s.channelsCollapsed) {
    const open = (parts: string[]): string => parts.map((p) => `${SIDEBAR} ${p}`.trim()).join(', ');
    const closed = (parts: string[]): string => parts.map((p) => `${SIDEBAR}:not(:hover) ${p}`.trim()).join(', ');
    const moving = ['', CHANNELS, ...CHANNEL_CONTENT];
    // Zero-length transitions with a delay switch width and visibility after that delay: the open delay by default, the close delay once unhovered.
    rules.push(`${open(moving)} { transition: width 0s ${OPEN_DELAY_MS}ms, visibility 0s ${OPEN_DELAY_MS}ms; }`);
    rules.push(`${closed(moving)} { transition-delay: ${CLOSE_DELAY_MS}ms; }`);
    rules.push(`${closed([''])} { width: calc(${s.serversHidden ? '0px' : SERVERS_W} + ${HOVER_EDGE_PX}px) !important; }`);
    rules.push(`${closed([CHANNELS])} { width: ${HOVER_EDGE_PX}px !important; }`);
    rules.push(`${closed(CHANNEL_CONTENT)} { visibility: hidden; }`);
  }
  return rules.join('\n');
}
