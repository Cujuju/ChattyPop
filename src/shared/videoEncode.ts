// Re-encoding a video on the sending device before upload: the presets and every decision around them, as pure functions.
// state/videoEncode.ts runs them through Mediabunny.
import type { DeviceChatSettings, VideoQuality } from './chatSettings';
import { BYTES_PER_MB } from './units';

export type EncodeQuality = Exclude<VideoQuality, 'best'>;

export interface EncodePreset {
  /** The output's shorter side, px. Smaller sources keep their size. */
  shortSide: number;
  /** Video bitrate at the full shorter side, bit/s. */
  videoBitrate: number;
}

const BITS_PER_KBIT = 1000;
const BITS_PER_MBIT = 1000 * BITS_PER_KBIT;
const BITS_PER_BYTE = 8;

export const ENCODE_PRESETS: Record<EncodeQuality, EncodePreset> = {
  // Discord iOS's own Standard: a 1320×2868 HEVC screen recording came out 720×1564 at ≈2 Mbit/s.
  standard: { shortSide: 720, videoBitrate: 2 * BITS_PER_MBIT },
  // Assumption: Discord's Data Saver size and rate; not measured.
  dataSaver: { shortSide: 480, videoBitrate: 1 * BITS_PER_MBIT },
};

/** AAC bitrate, bit/s. */
export const AUDIO_BITRATE = 128 * BITS_PER_KBIT;
/** Stereo: more channels are downmixed. */
export const MAX_AUDIO_CHANNELS = 2;
/** Faster sources are resampled to this rate; slower ones keep their own timing. */
export const MAX_FRAME_RATE = 60;
/** What 'best' re-encodes at when the original is over the upload limit. */
export const OVER_LIMIT_QUALITY: EncodeQuality = 'standard';
/** The next smaller quality tried when a re-encode is still over the limit; null when none is left. */
export const STEP_DOWN: Record<EncodeQuality, EncodeQuality | null> = { standard: 'dataSaver', dataSaver: null };
/** Least share of a fitting original's size a re-encode must save: it costs a wait on the scale of the video's length, so it must buy a clear cut. */
export const MIN_SAVINGS = 1 / 3;
export const MP4_TYPE = 'video/mp4';
const MP4_EXTENSION = '.mp4';
/** H.264 4:2:0 needs even dimensions. */
const DIMENSION_STEP = 2;

export type Rotation = 0 | 90 | 180 | 270;
export interface VideoSize {
  width: number;
  height: number;
}

export const isVideoType = (mimeType: string): boolean => mimeType.startsWith('video/');

/** The quality the device sends at: Data Saver on a cellular network while Data Saving is on. */
export const effectiveVideoQualityFor = (settings: Pick<DeviceChatSettings, 'videoQuality' | 'dataSaving'>, cellular: boolean): VideoQuality =>
  settings.dataSaving && cellular ? 'dataSaver' : settings.videoQuality;

/** The quality to re-encode at, or null to send the original. */
export const encodeQualityFor = (quality: VideoQuality, bytes: number, limitBytes: number): EncodeQuality | null =>
  quality !== 'best' ? quality : bytes > limitBytes ? OVER_LIMIT_QUALITY : null;

/** Upright size of square-pixel frames turned by `rotation` clockwise. */
export const displaySize = (coded: VideoSize, rotation: Rotation): VideoSize =>
  rotation % 180 === 0 ? coded : { width: coded.height, height: coded.width };

const evenFloor = (px: number): number => Math.max(DIMENSION_STEP, Math.floor(px / DIMENSION_STEP) * DIMENSION_STEP);

/** The upright output size: shorter side scaled down to the preset's (never up), aspect kept, both sides even. */
export function targetSize(display: VideoSize, preset: EncodePreset): VideoSize {
  const scale = Math.min(1, preset.shortSide / Math.min(display.width, display.height));
  return { width: evenFloor(display.width * scale), height: evenFloor(display.height * scale) };
}

/** The preset's video bitrate, scaled by area for outputs smaller than its shorter side. */
export function videoBitrateFor(size: VideoSize, preset: EncodePreset): number {
  const areaRatio = (Math.min(size.width, size.height) / preset.shortSide) ** 2;
  return Math.round(preset.videoBitrate * Math.min(1, areaRatio));
}

/** The output frame rate, or undefined to keep the source's timing. */
export const outputFrameRate = (sourceFps: number): number | undefined => (sourceFps > MAX_FRAME_RATE ? MAX_FRAME_RATE : undefined);

/** Estimated encoded size, bytes, ignoring container overhead. */
export const expectedEncodedBytes = (durationS: number, videoBitrate: number, hasAudio: boolean): number =>
  (durationS * (videoBitrate + (hasAudio ? AUDIO_BITRATE : 0))) / BITS_PER_BYTE;

/** Whether to re-encode: always over the limit; within it, only when the estimate saves at least MIN_SAVINGS. */
export const worthEncoding = (originalBytes: number, expectedBytes: number, limitBytes: number): boolean =>
  originalBytes > limitBytes || expectedBytes <= originalBytes * (1 - MIN_SAVINGS);

/** How a re-encode went: done, skipped (not worthEncoding), or impossible on this device. */
export type EncodeResult = { kind: 'encoded'; bytes: number } | { kind: 'skipped' } | { kind: 'unsupported' };
export type VideoLimitReason = 'unsupported' | 'tooLarge';
export type UploadChoice = { send: 'encoded' | 'original' } | { fail: VideoLimitReason };

/** Send the smaller of the original and the re-encode; fail when even that is over the limit. */
export function chooseUpload(originalBytes: number, result: EncodeResult, limitBytes: number): UploadChoice {
  const encodedSmaller = result.kind === 'encoded' && result.bytes < originalBytes;
  const bytes = encodedSmaller ? result.bytes : originalBytes;
  if (bytes <= limitBytes) return { send: encodedSmaller ? 'encoded' : 'original' };
  return { fail: result.kind === 'unsupported' ? 'unsupported' : 'tooLarge' };
}

/** The quality to retry at after choice, or null to stop: only a re-encode still over the limit steps down. */
export const retryQuality = (quality: EncodeQuality, choice: UploadChoice): EncodeQuality | null =>
  'fail' in choice && choice.fail === 'tooLarge' ? STEP_DOWN[quality] : null;

/** The UI's message for a video that can't go up. */
export function videoLimitMessage(reason: VideoLimitReason, limitBytes: number): string {
  const limit = `${Math.round(limitBytes / BYTES_PER_MB)} MB`;
  return reason === 'unsupported' ? `This device can't shrink this video; it's over the ${limit} limit.` : `This video is over the ${limit} limit, even shrunk.`;
}

/** `clip.mov` → `clip.mp4`. */
export function mp4Name(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}${MP4_EXTENSION}`;
}
