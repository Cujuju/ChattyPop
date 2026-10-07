// The account's Chat settings in Discord's settings proto, read from the gateway and written as the web client writes them.
// Verified 2026-10-06 from the web client's PATCH per toggle: text_and_images 6 → BoolValue 7, 9, 10, 12, 13, 21, 28 (off: empty
// wrapper); render_spoilers 4 (StringValue).
import { DEFAULT_SYNCED_CHAT_SETTINGS, type SpoilerMode, type SyncedChatSettings } from '@shared/chatSettings';
import type { DiscordClient } from './client';
import type { GatewayTap } from './gatewayTap';
import { bytesField, bytesOf, fields, has, message, varintField, varintOf, withFields, type ProtoField } from './settingsProto';

/** Discord's settings-proto type 1: PreloadedUserSettings. */
const PRELOADED_SETTINGS_PATH = 'users/@me/settings-proto/1';
/** USER_SETTINGS_PROTO_UPDATE's settings.type for PreloadedUserSettings. */
const PRELOADED_SETTINGS_TYPE = 1;
const TEXT_AND_IMAGES = 6;
/** A wrapper message's (BoolValue, StringValue) one field. */
const WRAPPED_VALUE = 1;
const BOOL_FIELDS = {
  imageDescriptions: 7,
  inlineAttachmentMedia: 9,
  inlineLinkMedia: 10,
  renderEmbeds: 12,
  renderReactions: 13,
  convertEmoticons: 21,
  stickersInAutocomplete: 28,
} as const satisfies Record<Exclude<keyof SyncedChatSettings, 'spoilers'>, number>;
const SPOILERS_FIELD = 4;
/** render_spoilers' strings (verified: each picked in the web client). */
const SPOILER_VALUES: Readonly<Record<SpoilerMode, string>> = { click: 'ON_CLICK', always: 'ALWAYS', moderated: 'IF_MODERATOR' };

type BoolKey = keyof typeof BOOL_FIELDS;
const BOOL_KEYS = Object.keys(BOOL_FIELDS) as BoolKey[];

/** A wrapper's value; undefined when the field is absent (the account keeps Discord's default). */
function wrapped(sub: ProtoField[], no: number): ProtoField[] | undefined {
  return has(sub, no) ? message(sub, no) : undefined;
}

/**
 * The chat settings in a PreloadedUserSettings message over `base`: Discord's defaults for a whole proto, the last known
 * settings for a partial update (a present field is a change; off is an empty wrapper). Null without text_and_images.
 */
export function chatSettingsFromProto(settings: Buffer, base: SyncedChatSettings = DEFAULT_SYNCED_CHAT_SETTINGS): SyncedChatSettings | null {
  const top = fields(settings);
  if (!has(top, TEXT_AND_IMAGES)) return null;
  const sub = message(top, TEXT_AND_IMAGES);
  const out: SyncedChatSettings = { ...base };
  for (const key of BOOL_KEYS) {
    const value = wrapped(sub, BOOL_FIELDS[key]);
    if (value) out[key] = varintOf(value, WRAPPED_VALUE) === 1;
  }
  const spoiler = wrapped(sub, SPOILERS_FIELD);
  const text = spoiler && bytesOf(spoiler, WRAPPED_VALUE)?.toString('utf8');
  const mode = (Object.keys(SPOILER_VALUES) as SpoilerMode[]).find((m) => SPOILER_VALUES[m] === text);
  if (mode) out.spoilers = mode;
  return out;
}

/**
 * The PATCH body's proto for `change` over the account's `current` settings: only text_and_images, whole, with the changed
 * fields rewritten and every other field kept byte for byte (the web client sends that sub-message whole).
 */
export function chatSettingsPatch(current: Buffer, change: Partial<SyncedChatSettings>): Buffer {
  const replace = new Map<number, Buffer>();
  for (const key of BOOL_KEYS) {
    const v = change[key];
    if (v !== undefined) replace.set(BOOL_FIELDS[key], bytesField(BOOL_FIELDS[key], v ? varintField(WRAPPED_VALUE, 1) : Buffer.alloc(0)));
  }
  if (change.spoilers) replace.set(SPOILERS_FIELD, bytesField(SPOILERS_FIELD, bytesField(WRAPPED_VALUE, Buffer.from(SPOILER_VALUES[change.spoilers], 'utf8'))));
  const sub = bytesOf(fields(current), TEXT_AND_IMAGES) ?? Buffer.alloc(0);
  return bytesField(TEXT_AND_IMAGES, withFields(sub, replace));
}

/**
 * Writes `change` to the account as the web client does (PATCH {settings: base64}), over the settings read just before so
 * another client's newer choices in text_and_images are kept. Resolves with the account's settings after it.
 */
export async function writeChatSettings(owner: DiscordClient, change: Partial<SyncedChatSettings>): Promise<SyncedChatSettings> {
  const { settings } = await owner.get<{ settings: string }>(PRELOADED_SETTINGS_PATH);
  const patch = chatSettingsPatch(Buffer.from(settings, 'base64'), change);
  const answer = await owner.patch<{ settings: string }>(PRELOADED_SETTINGS_PATH, { settings: patch.toString('base64') });
  return chatSettingsFromProto(Buffer.from(answer.settings, 'base64')) ?? DEFAULT_SYNCED_CHAT_SETTINGS;
}

/**
 * Calls `put` with the account's chat settings each time the gateway carries them: READY's whole proto, and updates. A
 * partial update without text_and_images changes nothing; a whole one without it means Discord's defaults.
 */
export function watchChatSettings(tap: GatewayTap, put: (settings: SyncedChatSettings) => void, diag: (event: string, data: Record<string, unknown>) => void): void {
  let known = DEFAULT_SYNCED_CHAT_SETTINGS;
  const take = (settings: SyncedChatSettings): void => {
    known = settings;
    put(settings);
  };
  const read = (base64: unknown, partial: boolean): void => {
    if (typeof base64 !== 'string') return;
    try {
      const settings = chatSettingsFromProto(Buffer.from(base64, 'base64'), partial ? known : DEFAULT_SYNCED_CHAT_SETTINGS);
      if (settings) take(settings);
      else if (!partial) take(DEFAULT_SYNCED_CHAT_SETTINGS);
    } catch (err) {
      diag('chat-settings-unreadable', { message: err instanceof Error ? err.message : String(err) });
    }
  };
  tap.on('dispatch', ({ t, d }) => {
    if (t === 'READY') read((d as { user_settings_proto?: unknown }).user_settings_proto, false);
    else if (t === 'USER_SETTINGS_PROTO_UPDATE') {
      const u = d as { settings?: { type?: number; proto?: unknown }; partial?: boolean };
      if (u.settings?.type === PRELOADED_SETTINGS_TYPE) read(u.settings.proto, u.partial === true);
    }
  });
}
