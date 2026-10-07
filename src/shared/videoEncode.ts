// Re-encoding a video on the sending device before upload: the presets and every decision around them, as pure functions.
// shared/videoUpload.ts sequences them; state/videoEncode.ts runs them through Mediabunny.
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
/** Frames closer together than this rate allows are dropped; slower timing is kept as it is. */
export const MAX_FRAME_RATE = 60;
/** Slot-boundary slack, in frames, so float error on a source exactly at MAX_FRAME_RATE never drops a frame. */
const FRAME_SLOT_TOLERANCE = 1e-3;
/** What 'best' re-encodes at when the original is over the upload limit. */
export const OVER_LIMIT_QUALITY: EncodeQuality = 'standard';
/** Encode qualities, largest first: a failed attempt steps to the next, and none gets more bits than one before it. */
export const QUALITY_ORDER: readonly EncodeQuality[] = ['standard', 'dataSaver'];
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

/** A preset's own rate for `size`: scaled by area below its shorter side. */
function presetBitrate(size: VideoSize, preset: EncodePreset): number {
  const areaRatio = (Math.min(size.width, size.height) / preset.shortSide) ** 2;
  return preset.videoBitrate * Math.min(1, areaRatio);
}

/** Video bitrate for an upright `source` at `quality`: its preset's rate, capped by every larger quality's rate for that source. */
export function videoBitrateFor(source: VideoSize, quality: EncodeQuality): number {
  const larger = QUALITY_ORDER.slice(0, QUALITY_ORDER.indexOf(quality) + 1).map((q) => ENCODE_PRESETS[q]);
  return Math.round(Math.min(...larger.map((preset) => presetBitrate(targetSize(source, preset), preset))));
}

/** A frame filter for one encode: true keeps the frame at `timestampS`; at most one frame per 1/MAX_FRAME_RATE slot. */
export function frameRateCap(): (timestampS: number) => boolean {
  let lastSlot = -Infinity;
  return (timestampS) => {
    const slot = Math.floor(timestampS * MAX_FRAME_RATE + FRAME_SLOT_TOLERANCE);
    if (slot <= lastSlot) return false;
    lastSlot = slot;
    return true;
  };
}

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

/** The quality to retry at after `choice`, or null to stop: any failure steps down while a smaller quality is left. */
export const retryQuality = (quality: EncodeQuality, choice: UploadChoice): EncodeQuality | null =>
  'fail' in choice ? (QUALITY_ORDER[QUALITY_ORDER.indexOf(quality) + 1] ?? null) : null;

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
