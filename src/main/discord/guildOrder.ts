// Reads guild order from gateway user-settings protobuf. Assumption: community schema uses guild_folders 14, folders 1 with guild_ids 1, and guild_positions 2; verify against live settings.
import type { GatewayTap } from './gatewayTap';
import { fields, fixed64s, has, message } from './settingsProto';

const FIELD = { guildFolders: 14, folders: 1, guildPositions: 2, guildIds: 1 } as const;
/** USER_SETTINGS_PROTO_UPDATE's settings.type for PreloadedUserSettings (settings-proto/1). */
const PRELOADED_SETTINGS_TYPE = 1;

/** Returns guild ids in folder order, falling back to legacy guild_positions. Partial settings without order return null. */
export function guildOrderFromSettings(settings: Buffer): string[] | null {
  const top = fields(settings);
  if (!has(top, FIELD.guildFolders)) return null;
  const folders = message(top, FIELD.guildFolders);
  const inFolders = folders.flatMap((f) => (f.no === FIELD.folders && 'bytes' in f ? fixed64s(fields(f.bytes), FIELD.guildIds) : []));
  return inFolders.length ? inFolders : fixed64s(folders, FIELD.guildPositions);
}

/** Calls `put` with the sidebar order each time the gateway carries it. Subscribe before the client opens its socket. */
export function watchGuildOrder(tap: GatewayTap, put: (guildIds: string[]) => void, diag: (event: string, data: Record<string, unknown>) => void): void {
  const read = (base64: unknown): void => {
    if (typeof base64 !== 'string') return;
    try {
      const order = guildOrderFromSettings(Buffer.from(base64, 'base64'));
      if (order) put(order);
    } catch (err) {
      diag('guild-order-unreadable', { message: err instanceof Error ? err.message : String(err) });
    }
  };
  tap.on('dispatch', ({ t, d }) => {
    if (t === 'READY') read((d as { user_settings_proto?: unknown }).user_settings_proto);
    else if (t === 'USER_SETTINGS_PROTO_UPDATE') {
      const s = (d as { settings?: { type?: number; proto?: unknown } }).settings;
      if (s?.type === PRELOADED_SETTINGS_TYPE) read(s.proto);
    }
  });
}
