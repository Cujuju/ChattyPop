// The re-encode's MP4 output streams into Blob parts while muxing and comes out byte-identical to an in-memory mux.
import { describe, expect, it } from 'vitest';
import { ALL_FORMATS, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, Input, Mp4OutputFormat, Output } from 'mediabunny';
import * as mb from 'mediabunny';
import { blobSink, uploadOutput } from '../src/renderer/src/state/videoEncodeOutput';

const SAMPLE_RATE = 48000;
const PACKET_S = 0.1;
/** Arbitrary payload size: the muxer never decodes it. */
const PACKET_BYTES = 9600;
/** Enough audio that the output passes several of uploadOutput's write chunks. */
const PACKETS = 1000;

/** Muxes PACKETS of MP3-labelled audio into `output`, calling `midway` before finalizing. */
async function mux(output: Output, midway: () => void = () => {}): Promise<void> {
  const source = new EncodedAudioPacketSource('mp3');
  output.addAudioTrack(source);
  await output.start();
  for (let i = 0; i < PACKETS; i++) {
    const data = new Uint8Array(PACKET_BYTES).fill(i % 251);
    const meta = i === 0 ? { decoderConfig: { codec: 'mp3', numberOfChannels: 1, sampleRate: SAMPLE_RATE } } : undefined;
    await source.add(new EncodedPacket(data, 'key', i * PACKET_S, PACKET_S), meta);
  }
  midway();
  await output.finalize();
}

describe('upload output', () => {
  it('hands bytes over while muxing instead of holding the whole file until it finalizes', async () => {
    // Regression: Fast Start ('in-memory') held every packet, then merged the whole file into one allocation on finalize.
    const { output, toFile } = uploadOutput(mb);
    let writtenBeforeFinalize = 0;
    await mux(output, () => (writtenBeforeFinalize = toFile('x.mp4').size));
    const total = toFile('x.mp4').size;
    expect(writtenBeforeFinalize).toBeGreaterThan(total / 2);
  });

  it('produces the same bytes as an in-memory mux, so the finalize patch lands', async () => {
    const { output, toFile } = uploadOutput(mb);
    await mux(output);
    const reference = new BufferTarget();
    await mux(new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: reference }));
    const file = toFile('clip.mp4');
    expect(file.type).toBe('video/mp4');
    // Buffer.equals: a deep toEqual on megabytes exhausts the heap.
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(reference.buffer!))).toBe(true);
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    expect(await input.computeDuration()).toBeCloseTo(PACKETS * PACKET_S);
    input.dispose();
  });
});

describe('blob sink', () => {
  const write = async (sink: WritableStream, chunks: { position: number; bytes: number[] }[]): Promise<void> => {
    const writer = sink.getWriter();
    for (const c of chunks) await writer.write({ type: 'write', position: c.position, data: new Uint8Array(c.bytes) });
    await writer.close();
  };

  it('appends, and splices a rewrite across part boundaries', async () => {
    const parts: Blob[] = [];
    await write(blobSink(parts), [
      { position: 0, bytes: [1, 2, 3] },
      { position: 3, bytes: [4, 5, 6] },
      { position: 2, bytes: [9, 9] },
    ]);
    expect([...new Uint8Array(await new Blob(parts).arrayBuffer())]).toEqual([1, 2, 9, 9, 5, 6]);
  });

  it('refuses a write past the end, which would leave a gap or straddle it', async () => {
    await expect(write(blobSink([]), [{ position: 1, bytes: [1] }])).rejects.toThrow('straddles the end');
  });
});
