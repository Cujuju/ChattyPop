// The Archive view's footer slot (chatFooter): what the host itself puts there.
import type { HostChatFooterItem } from '@/plugins/messageSlots';

/** The `composer` anchor, drawing nothing: a posting plugin's message box takes its place by it. */
export const HOST_FOOTER: readonly HostChatFooterItem[] = [{ id: 'composer', Component: () => null }];
