// The account's Chat settings in Discord's settings proto, read from the gateway and written as the web client writes them.
// Verified 2026-10-06 from the web client's PATCH per toggle: text_and_images 6 → BoolValue 7, 9, 10, 12, 13, 21, 28 (off: empty
// wrapper); render_spoilers 4 (StringValue).
import { DEFAULT_SYNCED_CHAT_SETTINGS, type SpoilerMode, type SyncedChatSettings } from '@shared/chatSettings';
import { EventEmitter } from 'node:events';
import { errorMessage } from '@shared/errors';
import { MS_PER_S } from '@shared/units';
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
 * How long a write waits for the gateway to show it before resolving anyway. Assumption: the echo lands within a second;
 * longer means the gateway is down, and READY on reconnect brings the whole state.
 */
const ECHO_WAIT_MS = 10 * MS_PER_S;

/**
 * The account's chat settings as the gateway delivers them, handed to `put`. Only the gateway sets them: its events come in
 * Discord's order, a write's echo included, so a write's own answer is never stored over a newer event.
 * Writes run one at a time: each rewrites text_and_images whole over a fresh read, so overlapping ones would undo each other.
 */
export class AccountChatSettings {
  private known = DEFAULT_SYNCED_CHAT_SETTINGS;
  /** The last `put`, which a write waits on so the archive holds its result before it resolves. */
  private stored: Promise<void> = Promise.resolve();
  private readonly shown = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    tap: GatewayTap,
    private readonly owner: DiscordClient,
    private readonly put: (settings: SyncedChatSettings) => Promise<void>,
    private readonly diag: (event: string, data: Record<string, unknown>) => void,
  ) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') this.read((d as { user_settings_proto?: unknown }).user_settings_proto, false);
      else if (t === 'USER_SETTINGS_PROTO_UPDATE') {
        const u = d as { settings?: { type?: number; proto?: unknown }; partial?: boolean };
        if (u.settings?.type === PRELOADED_SETTINGS_TYPE) this.read(u.settings.proto, u.partial === true);
      }
    });
  }

  /**
   * Writes `change` as the web client does (PATCH {settings: base64}) over a read just before. Resolves once the gateway
   * shows it and the archive holds that, or after ECHO_WAIT_MS; rejects with Discord's refusal.
   */
  write(change: Partial<SyncedChatSettings>): Promise<void> {
    const run = this.queue.then(() => this.writeNow(change));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeNow(change: Partial<SyncedChatSettings>): Promise<void> {
    const { settings } = await this.owner.get<{ settings: string }>(PRELOADED_SETTINGS_PATH);
    const patch = chatSettingsPatch(Buffer.from(settings, 'base64'), change);
    await this.owner.patch(PRELOADED_SETTINGS_PATH, { settings: patch.toString('base64') });
    await this.shows(change);
    await this.stored;
  }

  /** Resolves once the gateway's settings hold `change`, or after ECHO_WAIT_MS. */
  private shows(change: Partial<SyncedChatSettings>): Promise<void> {
    const held = (): boolean => (Object.keys(change) as (keyof SyncedChatSettings)[]).every((key) => this.known[key] === change[key]);
    if (held()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.shown.off('settings', check);
        resolve();
      };
      const check = (): void => {
        if (held()) done();
      };
      const timer = setTimeout(done, ECHO_WAIT_MS);
      this.shown.on('settings', check);
    });
  }

  private take(settings: SyncedChatSettings): void {
    this.known = settings;
    this.stored = this.put(settings).catch((err: unknown) => this.diag('chat-settings-unstored', { message: errorMessage(err) }));
    this.shown.emit('settings');
  }

  /** READY's whole proto, or an update; a partial without text_and_images changes nothing, a whole one means Discord's defaults. */
  private read(base64: unknown, partial: boolean): void {
    if (typeof base64 !== 'string') return;
    try {
      const settings = chatSettingsFromProto(Buffer.from(base64, 'base64'), partial ? this.known : DEFAULT_SYNCED_CHAT_SETTINGS);
      if (settings) this.take(settings);
      else if (!partial) this.take(DEFAULT_SYNCED_CHAT_SETTINGS);
    } catch (err) {
      this.diag('chat-settings-unreadable', { message: errorMessage(err) });
    }
  }
}
