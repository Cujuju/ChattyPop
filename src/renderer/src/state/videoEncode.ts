// Re-encodes a video on this device before upload: WebCodecs through Mediabunny, loaded on the first video. Desktop and
// the iPhone app's web view; support is feature-detected per file.
//
//   prepareUpload(file, quality, { limitBytes, signal?, onProgress? }) → the File to upload.
//     Non-video files come back unchanged; a video comes back as the smaller of the original and its `<base>.mp4`
//     re-encode, stepping down to Data Saver while nothing fits limitBytes. Throws VideoUploadError (message is for the
//     UI) when nothing fits, or the signal's reason when aborted. onProgress gets 0..1 per encode attempt.
//   effectiveVideoQuality() → the quality to pass: this device's choice, Data Saver on cellular while Data Saving is on.
//
// Sequencing: shared/videoUpload.ts. Presets and rules: shared/videoEncode.ts. Output memory: state/videoEncodeOutput.ts.
import type { Conversion, ConversionAudioOptions, Input, InputAudioTrack } from 'mediabunny';
import type { VideoQuality } from '@shared/chatSettings';
import {
  AUDIO_BITRATE,
  ENCODE_PRESETS,
  MAX_AUDIO_CHANNELS,
  displaySize,
  effectiveVideoQualityFor,
  expectedEncodedBytes,
  frameRateCap,
  mp4Name,
  targetSize,
  videoBitrateFor,
  worthEncoding,
  type EncodeQuality,
} from '@shared/videoEncode';
import { prepareVideoUpload, type EncodeAt, type EncodeAttempt, type PrepareUploadOptions } from '@shared/videoUpload';
import { deviceChatSettings } from './chatSettings';
import { onCellular } from './network';
import { uploadOutput } from './videoEncodeOutput';

export { VideoUploadError, type PrepareUploadOptions } from '@shared/videoUpload';

type Mediabunny = typeof import('mediabunny');

/** The quality uploads use now. Reactive. */
export const effectiveVideoQuality = (): VideoQuality => effectiveVideoQualityFor(deviceChatSettings(), onCellular());

export const prepareUpload = (file: File, quality: VideoQuality, opts: PrepareUploadOptions): Promise<File> =>
  prepareVideoUpload(file, quality, opts, encodeWithMediabunny);

const VIDEO_CODEC = 'avc';
const AUDIO_CODEC = 'aac';
const UNSUPPORTED: EncodeAttempt = { kind: 'unsupported' };
const SKIPPED: EncodeAttempt = { kind: 'skipped' };

const encodeWithMediabunny: EncodeAt = async (file, quality, { limitBytes, signal, onProgress }) => {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return UNSUPPORTED;
  const mb = await import('mediabunny');
  signal?.throwIfAborted();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  let conversion: Conversion | null = null;
  // Disposing the input fails its pending reads, so an abort stops preparation as well as the conversion.
  const cancel = (): void => {
    input.dispose();
    void conversion?.cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await encodeInput(mb, input, file, quality, limitBytes, onProgress, (c) => (conversion = c));
  } finally {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
  }
};

async function encodeInput(
  mb: Mediabunny,
  input: Input,
  file: File,
  quality: EncodeQuality,
  limitBytes: number,
  onProgress: PrepareUploadOptions['onProgress'],
  started: (conversion: Conversion) => void,
): Promise<EncodeAttempt> {
  if (!(await input.canRead())) return UNSUPPORTED;
  const video = await input.getPrimaryVideoTrack();
  if (!video) return UNSUPPORTED;
  const audio = await input.getPrimaryAudioTrack();

  const coded = { width: await video.getSquarePixelWidth(), height: await video.getSquarePixelHeight() };
  const upright = displaySize(coded, await video.getRotation());
  const size = targetSize(upright, ENCODE_PRESETS[quality]);
  const bitrate = videoBitrateFor(upright, quality);
  const expected = expectedEncodedBytes(await input.computeDuration(), bitrate, audio !== null);
  if (!worthEncoding(file.size, expected, limitBytes)) return SKIPPED;
  // Constant: measured on desktop, variable overshot the target up to 2× on busy frames; the size has to stay predictable.
  const videoQuality = new mb.Quality({ bitrate, bitrateMode: 'constant' });
  if (!(await mb.canEncodeVideo(VIDEO_CODEC, { ...size, quality: videoQuality }))) return UNSUPPORTED;
  const audioOptions = audio ? await audioOptionsFor(mb, audio) : undefined;
  if (audioOptions === null) return UNSUPPORTED;

  const { output, toFile } = uploadOutput(mb);
  const keepFrame = frameRateCap();
  const conversion = await mb.Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: {
      // Both sides given and already aspect-correct, so 'fill' never distorts.
      ...size,
      fit: 'fill',
      codec: VIDEO_CODEC,
      quality: videoQuality,
      forceTranscode: true,
      // Dropping keeps variable timing as is; Mediabunny's frameRate option would pad slower sources up to a constant rate.
      process: (sample) => (keepFrame(sample.timestamp) ? sample : null),
    },
    audio: audioOptions,
    showWarnings: false,
  });
  started(conversion);
  if (!conversion.utilizedTracks.includes(video) || (audio && !conversion.utilizedTracks.includes(audio))) {
    await conversion.cancel();
    return UNSUPPORTED;
  }
  if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
  await conversion.execute();
  return { kind: 'encoded', file: toFile(mp4Name(file.name)) };
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
