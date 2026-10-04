// Muted places (Settings → Notifications): servers and channels whose notices reach no device. Unfiltered by privacy mode.
import { SETTINGS_KEYS, normalizeNotificationSettings, type MutedPlaces } from '@shared/settings';
import type { PluginDb } from '../plugins/pluginDb';

/** The muted servers and channels as stored now. */
export function mutedPlaces(db: PluginDb): MutedPlaces {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEYS.notifications);
  return normalizeNotificationSettings(row ? JSON.parse(row.value) : undefined).muted;
}

/** Whether notices about `channelId` are muted: the channel, its parent (a thread's channel) or its server is. */
export function notificationMuted(db: PluginDb, channelId: string, muted: MutedPlaces = mutedPlaces(db)): boolean {
  if (muted.channelIds.includes(channelId)) return true;
  if (!muted.guildIds.length && !muted.channelIds.length) return false;
  const place = db
    .prepare<[string], { guildId: string | null; parentId: string | null }>('SELECT guild_id AS guildId, parent_id AS parentId FROM channels WHERE id = ?')
    .get(channelId);
  if (!place) return false;
  return (place.guildId !== null && muted.guildIds.includes(place.guildId)) || (place.parentId !== null && muted.channelIds.includes(place.parentId));
}

/** Whether notices about `channelIds` are muted: there is one and every one is. */
export function allMuted(db: PluginDb, channelIds: readonly string[]): boolean {
  const muted = mutedPlaces(db);
  return channelIds.length > 0 && channelIds.every((id) => notificationMuted(db, id, muted));
}
