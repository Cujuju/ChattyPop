// A minimal protobuf reader and writer for Discord's user settings (settings-proto, base64): top-level fields, nested
// messages, varints and 64-bit ids. Discord's schema has no groups.

const WIRE = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;
const FIXED64_BYTES = 8;
const FIXED32_BYTES = 4;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_MORE = 0x80;
const TAG_WIRE_BITS = 3;
const TAG_WIRE_MASK = 0b111;
/** A varint is at most 10 bytes (64 bits at 7 per byte); more is corruption. */
const VARINT_MAX_BYTES = 10;

/** One field as read; `raw` is its whole encoding (tag included), so a rewrite can keep fields it doesn't know. */
export type ProtoField = { no: number; raw: Buffer } & ({ varint: number } | { bytes: Buffer } | { fixed64: bigint } | { fixed32: number });

/** One message's top-level fields, in order. Throws on a wire type Discord's settings don't use (groups). */
export function fields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let p = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let n = 0; ; n++) {
      if (p >= buf.length || n >= VARINT_MAX_BYTES) throw new Error('Malformed varint in Discord settings.');
      const b = buf[p++]!;
      v += (b & VARINT_PAYLOAD_MASK) * mul;
      if (!(b & VARINT_MORE)) return v;
      mul *= 2 ** VARINT_PAYLOAD_BITS;
    }
  };
  /** Advances past `n` bytes, which must all be present. */
  const take = (n: number): number => {
    if (p + n > buf.length) throw new Error('Truncated field in Discord settings.');
    const at = p;
    p += n;
    return at;
  };
  while (p < buf.length) {
    const start = p;
    const tag = varint();
    const no = Math.floor(tag / 2 ** TAG_WIRE_BITS);
    const wire = tag & TAG_WIRE_MASK;
    const raw = (): Buffer => buf.subarray(start, p);
    if (wire === WIRE.varint) {
      const v = varint();
      out.push({ no, varint: v, raw: raw() });
    } else if (wire === WIRE.bytes) {
      const len = varint();
      const at = take(len);
      out.push({ no, bytes: buf.subarray(at, at + len), raw: raw() });
    } else if (wire === WIRE.fixed64) {
      const v = buf.readBigUInt64LE(take(FIXED64_BYTES));
      out.push({ no, fixed64: v, raw: raw() });
    } else if (wire === WIRE.fixed32) {
      const v = buf.readUInt32LE(take(FIXED32_BYTES));
      out.push({ no, fixed32: v, raw: raw() });
    } else throw new Error(`Unexpected protobuf wire type ${wire} in Discord settings.`);
  }
  return out;
}

/** Field `no` as a nested message's fields; absent, an empty message. */
export const message = (fs: ProtoField[], no: number): ProtoField[] => {
  const f = fs.find((x) => x.no === no && 'bytes' in x);
  return f && 'bytes' in f ? fields(f.bytes) : [];
};

/** Whether field `no` is present at all (a partial update names only what it changes). */
export const has = (fs: ProtoField[], no: number): boolean => fs.some((x) => x.no === no);

export const varintOf = (fs: ProtoField[], no: number): number | undefined => {
  const f = fs.find((x) => x.no === no && 'varint' in x);
  return f && 'varint' in f ? f.varint : undefined;
};

/** Field `no`'s raw value bytes (a nested message or string); undefined when absent. */
export const bytesOf = (fs: ProtoField[], no: number): Buffer | undefined => {
  const f = fs.find((x) => x.no === no && 'bytes' in x);
  return f && 'bytes' in f ? f.bytes : undefined;
};

/** Every 64-bit value of repeated fixed64 field `no` (Discord's ids), packed or not, in order, as decimal strings. */
export function fixed64s(fs: ProtoField[], no: number): string[] {
  const out: string[] = [];
  for (const f of fs) {
    if (f.no !== no) continue;
    if ('fixed64' in f) out.push(f.fixed64.toString());
    else if ('bytes' in f) {
      if (f.bytes.length % FIXED64_BYTES) throw new Error('Malformed packed ids in Discord settings.');
      for (let at = 0; at < f.bytes.length; at += FIXED64_BYTES) out.push(f.bytes.readBigUInt64LE(at).toString());
    }
  }
  return out;
}

/** A non-negative integer as a varint. */
function varintBytes(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= VARINT_MORE) {
    out.push((v % VARINT_MORE) | VARINT_MORE);
    v = Math.floor(v / VARINT_MORE);
  }
  out.push(v);
  return Buffer.from(out);
}

const tagBytes = (no: number, wire: number): Buffer => varintBytes(no * 2 ** TAG_WIRE_BITS + wire);

/** Field `no` holding a varint. */
export const varintField = (no: number, v: number): Buffer => Buffer.concat([tagBytes(no, WIRE.varint), varintBytes(v)]);

/** Field `no` holding bytes: a nested message or a string. */
export const bytesField = (no: number, value: Buffer): Buffer => Buffer.concat([tagBytes(no, WIRE.bytes), varintBytes(value.length), value]);

/** `buf` with every occurrence of each field in `replace` dropped and its encoding (when not null) appended. Others keep their bytes. */
export function withFields(buf: Buffer, replace: ReadonlyMap<number, Buffer | null>): Buffer {
  const kept = fields(buf).filter((f) => !replace.has(f.no)).map((f) => f.raw);
  return Buffer.concat([...kept, ...[...replace.values()].filter((b): b is Buffer => b !== null)]);
}
