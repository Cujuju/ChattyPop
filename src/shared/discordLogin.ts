// Signing the server's Discord client in from another machine: the server streams its Discord page as frames (CDP
// screencast) and takes the owner's pointer and keys back (CDP input). docs/server-client-split-plan.md §8.

/** Whether the server's Discord client is signed in: unknown until its page or its first request says. */
export type DiscordSessionState = 'unknown' | 'signed-in' | 'signed-out';

/** One frame of the server's Discord page: a JPEG, and the page size its pixels map to (CSS px). */
export interface LoginFrame {
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
}

/** A sign-in relay as a page that just loaded finds it: whether one runs, and the latest frame it sent (null: none yet). */
export interface LoginRelayState {
  running: boolean;
  frame: LoginFrame | null;
}

/** Pointer buttons a relayed click may name. */
export const RELAY_BUTTONS = ['none', 'left', 'right', 'middle'] as const;
export type RelayButton = (typeof RELAY_BUTTONS)[number];

/** Bits of a relayed key's `modifiers`: the held Alt, Ctrl, Meta (Command) and Shift keys, as CDP Input numbers them. */
export const RELAY_MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
/** Every modifier bit set: the largest `modifiers` value. */
const RELAY_MODIFIERS_ALL = Object.values(RELAY_MODIFIER).reduce((all, bit) => all | bit, 0);

/** The modifiers a key event says are held, as RELAY_MODIFIER bits. */
export const relayModifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (e.altKey ? RELAY_MODIFIER.alt : 0) | (e.ctrlKey ? RELAY_MODIFIER.ctrl : 0) | (e.metaKey ? RELAY_MODIFIER.meta : 0) | (e.shiftKey ? RELAY_MODIFIER.shift : 0);

/** What the owner does on a relayed frame, in the frame's page coordinates (CSS px). */
export type RelayInput =
  | { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: RelayButton; clickCount: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; text: string | null; keyCode: number; modifiers: number }
  | { kind: 'text'; text: string };

/** Longest text one relayed key or paste may carry. */
const RELAY_TEXT_MAX = 4096;
/** Largest coordinate or delta a relayed event may carry: well past any page. */
const RELAY_COORD_MAX = 100_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= RELAY_COORD_MAX ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length <= RELAY_TEXT_MAX ? v : null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A relayed input as sent (it crosses from another machine); null when malformed. */
export function normalizeRelayInput(v: unknown): RelayInput | null {
  if (!isObject(v)) return null;
  if (v['kind'] === 'mouse') {
    const [x, y] = [num(v['x']), num(v['y'])];
    const type = v['type'];
    const button = RELAY_BUTTONS.find((b) => b === v['button']) ?? 'none';
    const clickCount = Number.isInteger(v['clickCount']) ? Math.min(Math.max(v['clickCount'] as number, 0), 3) : 0;
    if (x === null || y === null || (type !== 'mousePressed' && type !== 'mouseReleased' && type !== 'mouseMoved')) return null;
    return { kind: 'mouse', type, x, y, button, clickCount };
  }
  if (v['kind'] === 'wheel') {
    const [x, y, deltaX, deltaY] = [num(v['x']), num(v['y']), num(v['deltaX']), num(v['deltaY'])];
    return x === null || y === null || deltaX === null || deltaY === null ? null : { kind: 'wheel', x, y, deltaX, deltaY };
  }
  if (v['kind'] === 'key') {
    const type = v['type'];
    const [key, code] = [text(v['key']), text(v['code'])];
    const keyCode = Number.isInteger(v['keyCode']) ? (v['keyCode'] as number) : 0;
    const modifiers = v['modifiers'];
    if (!Number.isInteger(modifiers) || (modifiers as number) < 0 || (modifiers as number) > RELAY_MODIFIERS_ALL) return null;
    if ((type !== 'keyDown' && type !== 'keyUp') || key === null || code === null) return null;
    return { kind: 'key', type, key, code, text: text(v['text']), keyCode, modifiers: modifiers as number };
  }
  if (v['kind'] === 'text') {
    const t = text(v['text']);
    return t ? { kind: 'text', text: t } : null;
  }
  return null;
}
