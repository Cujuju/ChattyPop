// Who is typing, from the embedded client's gateway traffic (TYPING_START); the renderer ends it with their message.
import type { AppEvent, PrivacyScope } from '@shared/contract';
import type { RawMember } from '@shared/discord';

/** TYPING_START as Discord documents it; a custom typing indicator (Nitro) adds fields the docs don't list yet. */
interface RawTypingStart {
  channel_id: string;
  user_id: string;
  guild_id?: string;
  member?: RawMember;
}

/** The documented TYPING_START fields; any other is a custom typing indicator's, noted once for diagnostics. */
const DOCUMENTED_TYPING_FIELDS = new Set(['channel_id', 'guild_id', 'user_id', 'timestamp', 'member']);

/** Converts typing dispatches for windows/phone. Returns null for other events, hidden channels or unknown privacy scope. */
export class TypingEvents {
  /** The undocumented field names were noted this session. */
  private extrasSeen = false;
  /** Channels privacy mode hides; null until core has said. */
  private hidden: ReadonlySet<string> | null = null;

  constructor(
    /** Session-health notes (diagnostics.log): field names and value types only, never ids or content. */
    private readonly diag: (event: string, data: Record<string, unknown>) => void,
  ) {}

  /** Core's privacy scope, at start and on each change (app.ts applyPrivacy). */
  setPrivacy(scope: PrivacyScope): void {
    this.hidden = new Set(scope.channelIds);
  }

  read(t: string, d: unknown): Extract<AppEvent, { type: 'typing' }> | null {
    if (t !== 'TYPING_START' || this.hidden === null) return null;
    const s = d as RawTypingStart & Record<string, unknown>;
    if (this.hidden.has(s.channel_id)) return null;
    const extras = Object.keys(s).filter((k) => !DOCUMENTED_TYPING_FIELDS.has(k));
    if (extras.length && !this.extrasSeen) {
      this.extrasSeen = true;
      // The custom indicator's verb is Discord's own vocabulary (a word or code), not the typist's: its value is noted.
      const suggestion = (s['typing_indicator_style'] as { typing_suggestion?: unknown } | undefined)?.typing_suggestion;
      this.diag('typing-start-extra-fields', { fields: Object.fromEntries(extras.map((k) => [k, describe(s[k])])), ...(typeof suggestion === 'object' ? {} : { suggestion }) });
    }
    const name = s.member?.nick || s.member?.user?.global_name || s.member?.user?.username;
    return { type: 'typing', channelId: s.channel_id, userId: s.user_id, ...(name ? { name } : {}) };
  }
}

/** A value's shape for diagnostics: its type, an object's keys with their types, never its content. */
function describe(v: unknown): string {
  if (v === null || typeof v !== 'object') return typeof v;
  return Array.isArray(v) ? `array(${v.length})` : `object{${Object.entries(v).map(([k, x]) => `${k}:${describe(x)}`).join(',')}}`;
}
