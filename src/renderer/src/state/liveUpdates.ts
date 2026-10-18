// Whether new messages, DMs and alerts arrive live from the Discord client (main/discord/liveUpdates.ts).
import { api } from '@/api';
import type { LiveUpdatesState } from '@shared/types/ipc';
import { createPushedValue } from './events';

const pushed = createPushedValue(() => api.discord.liveUpdates(), 'live-updates', (e) => e.state);
/** Null until read (or where the shell can't tell, as on the phone). */
export const liveUpdates = (): LiveUpdatesState | null => pushed.value();
export const reconnectDiscord = (): Promise<void> => api.discord.reconnect();
