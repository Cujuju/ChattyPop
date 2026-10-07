// The re-encode's MP4 output, streamed into Blob parts as it encodes, so the page holds a few MiB of it at a time.
// Index (moov) last: Fast Start holds and merges the whole file in memory; a reserved index needs packet counts
// Conversion can't set. Players range-request a trailing index.
import type { Output, StreamTargetChunk } from 'mediabunny';
import { BYTES_PER_MB } from '@shared/units';
import { MP4_TYPE } from '@shared/videoEncode';

type Mediabunny = typeof import('mediabunny');

/** Bytes Mediabunny gathers before handing them over; it holds at most a few such chunks, which bounds the page's share. */
const WRITE_CHUNK_BYTES = 4 * BYTES_PER_MB;

export interface UploadOutput {
  output: Output;
  /** The bytes written so far as a File; complete once `output` is finalized. */
  toFile(name: string): File;
}

export function uploadOutput(mb: Mediabunny): UploadOutput {
  const parts: Blob[] = [];
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: false }),
    target: new mb.StreamTarget(blobSink(parts), { chunked: true, chunkSize: WRITE_CHUNK_BYTES }),
  });
  return { output, toFile: (name) => new File(parts, name, { type: MP4_TYPE }) };
}

/** Positioned writes into Blob parts: appends at the end, and splices rewrites of written bytes (the mdat size, patched on finalize). */
export function blobSink(parts: Blob[]): WritableStream<StreamTargetChunk> {
  let size = 0;
  return new WritableStream({
    write({ data, position }) {
      if (position === size) {
        parts.push(new Blob([data]));
        size += data.byteLength;
      } else if (position + data.byteLength <= size) {
        rewrite(parts, position, data);
      } else {
        throw new Error(`MP4 write at ${position}+${data.byteLength} straddles the end at ${size}`);
      }
    },
  });
}

/** Replaces bytes at `position` across whichever parts hold them; Blob slices share storage, so only `data` is copied. */
function rewrite(parts: Blob[], position: number, data: Uint8Array<ArrayBuffer>): void {
  const end = position + data.byteLength;
  let start = 0;
  for (let i = 0; i < parts.length && start < end; i++) {
    const part = parts[i]!;
    const partEnd = start + part.size;
    if (partEnd > position) {
      const from = Math.max(position, start);
      const to = Math.min(end, partEnd);
      parts[i] = new Blob([part.slice(0, from - start), data.subarray(from - position, to - position), part.slice(to - start)]);
    }
    start = partEnd;
  }
}
