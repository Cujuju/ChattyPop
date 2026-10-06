// Pure leader-key rules support press-then-key shortcuts; state/shortcuts.ts wires dispatch.

/** Space: the default leader. */
export const DEFAULT_LEADER_KEY = ' ';
/** An armed leader waits this long for its key, then disarms (StockApp's DEFAULT_LEADER_TIMEOUT). */
export const LEADER_TIMEOUT_MS = 1500;

/** Keys held for another key: pressing one alone keeps the leader armed (Shift for a shifted symbol). */
export const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);
/** One character that is no letter or digit: letters and digits are shortcut keys. */
const SYMBOL_KEY = /^[^\p{L}\p{N}]$/u;

/** Whether `key` (a KeyboardEvent key) has a leader's shape: Space or one symbol. Settings also refuses one a shortcut takes (leaderRefusal). */
export const isLeaderKey = (key: string): boolean => SYMBOL_KEY.test(key);
/** A stored leader, or Space when it is missing or can't be one. */
export const normalizeLeaderKey = (v: unknown): string => (typeof v === 'string' && isLeaderKey(v) ? v : DEFAULT_LEADER_KEY);
/** A key as the status bar and Settings name it: "space", "tab", "/". */
export const keyLabel = (key: string): string => (key === ' ' ? 'space' : key.toLowerCase());

/** A key press as the leader reads it (a KeyboardEvent fits). */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface LeaderContext {
  leaderKey: string;
  /** Keys belong elsewhere: a text field has focus, or a window, menu or viewer is open. */
  blocked: boolean;
  /** Focus is on a control reached by keyboard that Space presses (a button): Space keeps that job. */
  spacePresses: boolean;
}

/** What a key press does: nothing (`pass`), arm the leader, disarm it, or run the shortcut for `key`. */
export type LeaderStep = { kind: 'pass' } | { kind: 'arm' } | { kind: 'disarm'; consume: boolean } | { kind: 'run'; key: string };

const PASS: LeaderStep = { kind: 'pass' };

/** Leader requires no fields/overlays or Ctrl/Alt/Win. Next shortcut runs; unknown keys/Escape disarm. Chords/field focus disarm without consuming keys. */
export function leaderStep(armed: boolean, press: KeyPress, ctx: LeaderContext): LeaderStep {
  const chord = press.ctrlKey || press.altKey || press.metaKey;
  if (!armed) {
    const arms = press.key === ctx.leaderKey && !chord && !ctx.blocked && !(press.key === ' ' && ctx.spacePresses);
    return arms ? { kind: 'arm' } : PASS;
  }
  if (MODIFIER_KEYS.has(press.key)) return PASS;
  if (ctx.blocked || chord) return { kind: 'disarm', consume: false };
  if (press.key === 'Escape') return { kind: 'disarm', consume: true };
  return { kind: 'run', key: press.key };
}


/** An Escape press as the field rule reads it (a KeyboardEvent fits). */
export interface EscapePress extends KeyPress {
  shiftKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
}

export interface EscapeContext {
  /** Focus is in a text field (input, textarea, contenteditable). */
  inField: boolean;
  /** A window, menu or picker owns Escape: the field is inside one, or one is open (a context menu, the lightbox). */
  escapeOwned: boolean;
}

/** Plain Escape blurs fields unless already handled, composing IME or owned by a window, enabling subsequent leader shortcuts. */
export function escapeBlursField(press: EscapePress, ctx: EscapeContext): boolean {
  const plain = !press.ctrlKey && !press.altKey && !press.metaKey && !press.shiftKey;
  return press.key === 'Escape' && plain && !press.defaultPrevented && !press.isComposing && ctx.inField && !ctx.escapeOwned;
}