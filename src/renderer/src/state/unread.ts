// Host unread.
import { unreadCounts } from './unreadCounts';
import { bundledUnread, type UnreadSource } from '@/plugins/slots';


/** Unseen items in panel `id`; 0 for panels without any. */
const source = (id: string): UnreadSource | undefined => unreadCounts.source(id) ?? bundledUnread(id);

export const unreadCount = (id: string): number => source(id)?.count() ?? 0;

export const markPanelSeen = (id: string): void => source(id)?.markSeen?.();

export const panelShown = (id: string): void => source(id)?.onShown?.();
