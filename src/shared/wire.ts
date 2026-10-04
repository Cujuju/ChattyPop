// The phone transport's codec (docs/plugin-architecture.md §5): JSON plus bytes and explicit undefined. Desktop IPC stays
// structured clone; what the phone may receive or send is typed to WireValue (pluginChannels.ts).

/** Bytes travel as `{ $u8: base64 }`: JSON has no binary. */
const BYTES_TAG = '$u8';
/** Undefined travels as `{ $void: true }`: JSON drops it from objects, nulls it in arrays and has no top-level form. */
const VOID_TAG = '$void';
/** Characters converted per String.fromCharCode call; stays under engines' argument-count limits. */
const BINARY_CHUNK = 0x8000;

/**
 * What the phone transport carries exactly: JSON values, bytes (arriving as Uint8Array) and undefined (a whole value, a
 * property or an array element: a void result round-trips). An object shaped `{ $u8: string }` or `{ $void: true }` is read as its tag.
 */
export type WireValue = undefined | null | boolean | number | string | Uint8Array | readonly WireValue[] | { readonly [key: string]: WireValue };

/**
 * `T` with every part the wire can't carry (a function, a Date, Map or class instance with methods, bigint, symbol, unknown)
 * turned into never; interfaces pass, though they lack WireValue's index signature.
 */
export type Wire<T> = T extends undefined | void | null | boolean | number | string
  ? T
  : T extends Uint8Array
    ? T
    : T extends (...args: never[]) => unknown
      ? never
      : T extends object
        ? { [K in keyof T]: Wire<T[K]> }
        : never;

/** Whether every part of `T` is a WireValue. */
export type IsWire<T> = [T] extends [Wire<T>] ? true : false;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A tag object: exactly one own key, `tag`. */
const tagged = (v: unknown, tag: string): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && Object.hasOwn(v, tag);

/** `value` as the phone transport's text; decodeWire gives back an equal WireValue. */
export function encodeWire(value: unknown): string {
  // The holder's own value: JSON.stringify has already applied a Buffer's toJSON to `v`.
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    if (raw instanceof Uint8Array) return { [BYTES_TAG]: toBase64(raw) };
    return v === undefined ? { [VOID_TAG]: true } : v;
  });
}

/**
 * Parsed JSON `v` with its tags read. Not a JSON.parse reviver: one returning undefined deletes the element, leaving an
 * array hole that `every`/`some` skip. Entries are copied as data properties, so a `__proto__` key stays a key.
 */
function revive(v: unknown): WireValue {
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v !== 'object' || v === null) return v as WireValue;
  if (tagged(v, BYTES_TAG) && typeof v[BYTES_TAG] === 'string') return fromBase64(v[BYTES_TAG]);
  if (tagged(v, VOID_TAG) && v[VOID_TAG] === true) return undefined;
  return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, revive(x)]));
}

/** The WireValue `text` encodes (an undefined element or property arrives present); throws on text that isn't JSON. */
export function decodeWire(text: string): WireValue {
  return revive(JSON.parse(text));
}
