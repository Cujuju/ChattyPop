// A minimal protobuf reader for Discord's user settings (settings-proto, base64): top-level fields, nested messages,
// varints and 64-bit ids. Discord's schema has no groups.

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

export type ProtoField = { no: number; varint: number } | { no: number; bytes: Buffer } | { no: number; fixed64: bigint };

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
    const tag = varint();
    const no = Math.floor(tag / 2 ** TAG_WIRE_BITS);
    const wire = tag & TAG_WIRE_MASK;
    if (wire === WIRE.varint) out.push({ no, varint: varint() });
    else if (wire === WIRE.bytes) {
      const len = varint();
      const at = take(len);
      out.push({ no, bytes: buf.subarray(at, at + len) });
    } else if (wire === WIRE.fixed64) out.push({ no, fixed64: buf.readBigUInt64LE(take(FIXED64_BYTES)) });
    else if (wire === WIRE.fixed32) take(FIXED32_BYTES);
    else throw new Error(`Unexpected protobuf wire type ${wire} in Discord settings.`);
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
