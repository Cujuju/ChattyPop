// Byte-range replies (RFC 9110 §14): media elements seek through them, and iOS Safari plays video only through them.

const HTTP_PARTIAL_CONTENT = 206;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
/** One `bytes=` range: first-last, first- (to the end) or -suffix (the last N bytes). */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** What a Response can carry as its body. */
type Body = ConstructorParameters<typeof Response>[0];

/** A request's range against a body of `size` bytes: inclusive offsets, unsatisfiable, or null for the whole body. */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses a Range header. Absent, malformed or multi-range headers get the whole body, which the RFC allows. */
export function byteRange(header: string | null | undefined, size: number): ByteRange {
  const m = header ? SINGLE_RANGE.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return end < start ? null : { start, end };
}

/** Returns whole or requested byte ranges, always advertising range support. body(start,end) supplies inclusive bytes. */
export function rangedResponse(rangeHeader: string | null | undefined, size: number, type: string, body: (start: number, end: number) => Body): Response {
  const headers = { 'content-type': type, 'accept-ranges': 'bytes' };
  const r = byteRange(rangeHeader, size);
  if (r === 'unsatisfiable') return new Response(null, { status: HTTP_RANGE_NOT_SATISFIABLE, headers: { ...headers, 'content-range': `bytes */${size}` } });
  if (!r) return new Response(size ? body(0, size - 1) : null, { headers: { ...headers, 'content-length': String(size) } });
  return new Response(body(r.start, r.end), {
    status: HTTP_PARTIAL_CONTENT,
    headers: { ...headers, 'content-length': String(r.end - r.start + 1), 'content-range': `bytes ${r.start}-${r.end}/${size}` },
  });
}
