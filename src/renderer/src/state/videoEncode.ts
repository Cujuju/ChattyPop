// Re-encodes a video on this device before upload: WebCodecs through Mediabunny, loaded on the first video. Desktop and
// the iPhone app's web view; support is feature-detected per file.
//
//   prepareUpload(file, quality, { limitBytes, signal?, onProgress? }) → the File to upload.
//     Non-video files come back unchanged; a video comes back as the smaller of the original and its `<base>.mp4`
//     re-encode, stepping down to Data Saver while still over limitBytes. Throws VideoUploadError (message is for the UI)
//     when nothing fits, or the signal's reason when aborted. onProgress gets 0..1 per encode pass.
//   effectiveVideoQuality() → the quality to pass: this device's choice, Data Saver on cellular while Data Saving is on.
//
// Decisions and presets: shared/videoEncode.ts. Memory: input is read in slices; the output (≈ its size, held until the
// MP4 is finalized so its index can lead) collects as Blob parts.
import type { ConversionAudioOptions, Input, InputAudioTrack, StreamTargetChunk } from 'mediabunny';
import type { VideoQuality } from '@shared/chatSettings';
import {
  AUDIO_BITRATE,
  ENCODE_PRESETS,
  MAX_AUDIO_CHANNELS,
  MP4_TYPE,
  chooseUpload,
  displaySize,
  effectiveVideoQualityFor,
  encodeQualityFor,
  expectedEncodedBytes,
  isVideoType,
  mp4Name,
  outputFrameRate,
  retryQuality,
  targetSize,
  videoBitrateFor,
  videoLimitMessage,
  worthEncoding,
  type EncodePreset,
  type EncodeResult,
  type VideoLimitReason,
} from '@shared/videoEncode';
import { deviceChatSettings } from './chatSettings';
import { onCellular } from './network';

type Mediabunny = typeof import('mediabunny');

export interface PrepareUploadOptions {
  /** The destination's upload limit, bytes. */
  limitBytes: number;
  signal?: AbortSignal;
  onProgress?(fraction: number): void;
}

/** A video that can't go up within the limit; `message` is written for the UI. */
export class VideoUploadError extends Error {
  constructor(readonly reason: VideoLimitReason, limitBytes: number) {
    super(videoLimitMessage(reason, limitBytes));
    this.name = 'VideoUploadError';
  }
}

/** The quality uploads use now. Reactive. */
export const effectiveVideoQuality = (): VideoQuality => effectiveVideoQualityFor(deviceChatSettings(), onCellular());

const VIDEO_CODEC = 'avc';
const AUDIO_CODEC = 'aac';
/** Packets read to measure the source frame rate: two seconds at the cap. */
const FRAME_RATE_SAMPLE_PACKETS = 120;

export async function prepareUpload(file: File, quality: VideoQuality, opts: PrepareUploadOptions): Promise<File> {
  if (!isVideoType(file.type)) return file;
  let target = encodeQualityFor(quality, file.size, opts.limitBytes);
  while (target) {
    opts.signal?.throwIfAborted();
    const { result, encoded } = await encode(file, ENCODE_PRESETS[target], opts);
    const choice = chooseUpload(file.size, result, opts.limitBytes);
    if ('send' in choice) return choice.send === 'encoded' && encoded ? encoded : file;
    const next = retryQuality(target, choice);
    if (!next) throw new VideoUploadError(choice.fail, opts.limitBytes);
    target = next;
  }
  return file;
}

const UNSUPPORTED = { result: { kind: 'unsupported' } } as const;
const SKIPPED = { result: { kind: 'skipped' } } as const;
type Encoded = { result: EncodeResult; encoded?: File };

async function encode(file: File, preset: EncodePreset, opts: PrepareUploadOptions): Promise<Encoded> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return UNSUPPORTED;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    return await encodeInput(mb, input, file, preset, opts);
  } finally {
    input.dispose();
  }
}

async function encodeInput(mb: Mediabunny, input: Input, file: File, preset: EncodePreset, { limitBytes, signal, onProgress }: PrepareUploadOptions): Promise<Encoded> {
  if (!(await input.canRead())) return UNSUPPORTED;
  const video = await input.getPrimaryVideoTrack();
  if (!video) return UNSUPPORTED;
  const audio = await input.getPrimaryAudioTrack();

  const coded = { width: await video.getSquarePixelWidth(), height: await video.getSquarePixelHeight() };
  const size = targetSize(displaySize(coded, await video.getRotation()), preset);
  const bitrate = videoBitrateFor(size, preset);
  const expected = expectedEncodedBytes(await input.computeDuration(), bitrate, audio !== null);
  if (!worthEncoding(file.size, expected, limitBytes)) return SKIPPED;
  // Constant: measured on desktop, variable overshot the target up to 2× on busy frames; the size has to stay predictable.
  const quality = new mb.Quality({ bitrate, bitrateMode: 'constant' });
  if (!(await mb.canEncodeVideo(VIDEO_CODEC, { ...size, quality }))) return UNSUPPORTED;
  const audioOptions = audio ? await audioOptionsFor(mb, audio) : undefined;
  if (audioOptions === null) return UNSUPPORTED;
  const { averagePacketRate } = await video.computePacketStats(FRAME_RATE_SAMPLE_PACKETS);

  const parts: Blob[] = [];
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.StreamTarget(blobParts(parts), { chunked: true }) });
  const conversion = await mb.Conversion.init({
    input,
    output,
    tracks: 'primary',
    // Both sides given and already aspect-correct, so 'fill' never distorts.
    video: { ...size, fit: 'fill', codec: VIDEO_CODEC, quality, frameRate: outputFrameRate(averagePacketRate), forceTranscode: true },
    audio: audioOptions,
    showWarnings: false,
  });
  if (!conversion.utilizedTracks.includes(video) || (audio && !conversion.utilizedTracks.includes(audio))) return UNSUPPORTED;
  if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);

  const cancel = (): void => void conversion.cancel();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await conversion.execute();
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    // Probes can pass yet the encoder fail on the frames (e.g. HDR); treat it as no support for this file.
    console.warn('[video encode]', err);
    return UNSUPPORTED;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  const encoded = new File(parts, mp4Name(file.name), { type: MP4_TYPE });
  return { result: { kind: 'encoded', bytes: encoded.size }, encoded };
}

/** AAC at AUDIO_BITRATE; an AAC source is copied where this device can't encode AAC; null when neither works. */
async function audioOptionsFor(mb: Mediabunny, audio: InputAudioTrack): Promise<ConversionAudioOptions | null> {
  const numberOfChannels = Math.min(await audio.getNumberOfChannels(), MAX_AUDIO_CHANNELS);
  const quality = new mb.Quality({ bitrate: AUDIO_BITRATE });
  if (await mb.canEncodeAudio(AUDIO_CODEC, { numberOfChannels, sampleRate: await audio.getSampleRate(), quality })) {
    return { codec: AUDIO_CODEC, numberOfChannels, quality, forceTranscode: true };
  }
  return (await audio.getCodec()) === AUDIO_CODEC ? {} : null;
}

/** A sink for the muxer's writes; fastStart 'in-memory' writes in order, so each chunk appends. */
function blobParts(parts: Blob[]): WritableStream<StreamTargetChunk> {
  let written = 0;
  return new WritableStream({
    write(chunk) {
      if (chunk.position !== written) throw new Error(`MP4 write at ${chunk.position}, expected ${written}`);
      parts.push(new Blob([chunk.data]));
      written += chunk.data.byteLength;
    },
  });
}
