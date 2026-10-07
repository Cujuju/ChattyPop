// Device-side video re-encode decisions: output size and rate per quality, when the original is kept, and the cellular rule.
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_CHAT_SETTINGS } from '@shared/chatSettings';
import { isShellNetworkDetail } from '@shared/shell';
import { BYTES_PER_MB } from '@shared/units';
import {
  AUDIO_BITRATE,
  ENCODE_PRESETS,
  MAX_FRAME_RATE,
  MIN_SAVINGS,
  chooseUpload,
  displaySize,
  effectiveVideoQualityFor,
  encodeQualityFor,
  expectedEncodedBytes,
  isVideoType,
  mp4Name,
  frameRateCap,
  retryQuality,
  targetSize,
  videoBitrateFor,
  videoLimitMessage,
  worthEncoding,
} from '@shared/videoEncode';

const { standard, dataSaver } = ENCODE_PRESETS;
const LIMIT = 10 * BYTES_PER_MB;

describe('target size', () => {
  it("matches Discord iOS's Standard re-encode of a 1320×2868 recording", () => {
    expect(targetSize({ width: 1320, height: 2868 }, standard)).toEqual({ width: 720, height: 1564 });
  });

  it('scales the shorter side, landscape or portrait, keeping aspect', () => {
    expect(targetSize({ width: 1920, height: 1080 }, standard)).toEqual({ width: 1280, height: 720 });
    expect(targetSize({ width: 1080, height: 1920 }, standard)).toEqual({ width: 720, height: 1280 });
    expect(targetSize({ width: 1920, height: 1080 }, dataSaver)).toEqual({ width: 852, height: 480 });
  });

  it('never upscales, and rounds odd sides down to even', () => {
    expect(targetSize({ width: 640, height: 360 }, standard)).toEqual({ width: 640, height: 360 });
    expect(targetSize({ width: 853, height: 479 }, standard)).toEqual({ width: 852, height: 478 });
    expect(targetSize({ width: 1, height: 1 }, standard)).toEqual({ width: 2, height: 2 });
  });

  it('works on the upright size: a 90° or 270° rotation swaps the sides, 180° keeps them', () => {
    const coded = { width: 1920, height: 1080 };
    expect(displaySize(coded, 0)).toEqual(coded);
    expect(displaySize(coded, 180)).toEqual(coded);
    expect(displaySize(coded, 90)).toEqual({ width: 1080, height: 1920 });
    expect(targetSize(displaySize(coded, 270), standard)).toEqual({ width: 720, height: 1280 });
  });
});

describe('bitrate and frame rate', () => {
  it("uses the preset's rate when the source fills it", () => {
    const portrait = { width: 1320, height: 2868 };
    expect(videoBitrateFor(portrait, 'standard')).toBe(standard.videoBitrate);
    expect(videoBitrateFor(portrait, 'dataSaver')).toBe(dataSaver.videoBitrate);
  });

  it('scales the rate by area for sources below the preset size', () => {
    expect(videoBitrateFor({ width: 640, height: 360 }, 'standard')).toBe(standard.videoBitrate / 4);
  });

  it('never gives Data Saver more bits than Standard for the same source', () => {
    // Regression: at 640×360, Data Saver's own area scaling gave 562,500 bit/s against Standard's 500,000.
    expect(videoBitrateFor({ width: 640, height: 360 }, 'dataSaver')).toBe(videoBitrateFor({ width: 640, height: 360 }, 'standard'));
    for (let short = 2; short <= 2160; short += 2) {
      for (const source of [{ width: Math.round((short * 16) / 9), height: short }, { width: short, height: short * 2 }]) {
        expect(videoBitrateFor(source, 'dataSaver')).toBeLessThanOrEqual(videoBitrateFor(source, 'standard'));
      }
    }
  });
  const kept = (fps: number, seconds: number, start = 0): number => {
    const keep = frameRateCap();
    let n = 0;
    for (let i = 0; i < fps * seconds; i++) if (keep(start + i / fps)) n++;
    return n;
  };

  it('keeps every frame at or under the cap, whatever the source rate', () => {
    expect(kept(MAX_FRAME_RATE, 10)).toBe(MAX_FRAME_RATE * 10);
    expect(kept(59.94, 10)).toBe(Math.ceil(59.94 * 10));
    expect(kept(30, 10, 3.7)).toBe(300);
  });

  it('drops frames above the cap anywhere in the video, not only past a sampled prefix', () => {
    // Regression: the cap read the average rate of the first packets, so a later 120 FPS stretch went through uncapped.
    const keep = frameRateCap();
    const times = [...Array.from({ length: 300 }, (_, i) => i / 30), ...Array.from({ length: 1200 }, (_, i) => 10 + i / 120)];
    const after = times.filter((t) => keep(t)).filter((t) => t >= 10);
    expect(after.length).toBe(10 * MAX_FRAME_RATE);
    for (let i = 1; i < after.length; i++) expect(after[i]! - after[i - 1]!).toBeGreaterThan(1 / MAX_FRAME_RATE / 2);
  });
  it('estimates size from duration and rates', () => {
    const seconds = 98;
    expect(expectedEncodedBytes(seconds, standard.videoBitrate, true)).toBe((seconds * (standard.videoBitrate + AUDIO_BITRATE)) / 8);
    expect(expectedEncodedBytes(seconds, standard.videoBitrate, false)).toBe((seconds * standard.videoBitrate) / 8);
  });
});

describe('quality', () => {
  it("re-encodes at Standard and Data Saver; 'best' only when over the limit, then at Standard", () => {
    expect(encodeQualityFor('standard', 1, LIMIT)).toBe('standard');
    expect(encodeQualityFor('dataSaver', 1, LIMIT)).toBe('dataSaver');
    expect(encodeQualityFor('best', LIMIT, LIMIT)).toBeNull();
    expect(encodeQualityFor('best', LIMIT + 1, LIMIT)).toBe('standard');
  });

  it('uses Data Saver only on cellular while Data Saving is on', () => {
    const best = { ...DEFAULT_DEVICE_CHAT_SETTINGS, videoQuality: 'best' as const };
    expect(effectiveVideoQualityFor({ ...best, dataSaving: true }, true)).toBe('dataSaver');
    expect(effectiveVideoQualityFor({ ...best, dataSaving: true }, false)).toBe('best');
    expect(effectiveVideoQualityFor({ ...best, dataSaving: false }, true)).toBe('best');
  });

  it("reads the iPhone app's network event detail only when well formed", () => {
    expect(isShellNetworkDetail({ cellular: true })).toBe(true);
    expect(isShellNetworkDetail({ cellular: 'yes' })).toBe(false);
    expect(isShellNetworkDetail(null)).toBe(false);
  });
});

describe('when to re-encode', () => {
  const original = 6 * BYTES_PER_MB;

  it('re-encodes a file that fits only when it saves at least MIN_SAVINGS', () => {
    const cutoff = original * (1 - MIN_SAVINGS);
    expect(worthEncoding(original, cutoff, LIMIT)).toBe(true);
    expect(worthEncoding(original, cutoff + 1, LIMIT)).toBe(false);
  });

  it('always tries over the limit, even when the estimate is no smaller', () => {
    expect(worthEncoding(LIMIT + 1, 2 * LIMIT, LIMIT)).toBe(true);
  });

  it('steps a re-encode still over the limit down from Standard to Data Saver, then stops', () => {
    expect(retryQuality('standard', { fail: 'tooLarge' })).toBe('dataSaver');
    expect(retryQuality('dataSaver', { fail: 'tooLarge' })).toBeNull();
  });

  it('steps down when Standard is refused too: a device may encode 852×480 but not 1280×720', () => {
    expect(retryQuality('standard', { fail: 'unsupported' })).toBe('dataSaver');
    expect(retryQuality('dataSaver', { fail: 'unsupported' })).toBeNull();
  });

  it('never steps down once a file was chosen', () => {
    expect(retryQuality('standard', { send: 'encoded' })).toBeNull();
    expect(retryQuality('standard', { send: 'original' })).toBeNull();
  });
});

describe('which file goes up', () => {  const original = 8 * BYTES_PER_MB;

  it('sends the re-encode only when smaller', () => {
    expect(chooseUpload(original, { kind: 'encoded', bytes: original - 1 }, LIMIT)).toEqual({ send: 'encoded' });
    expect(chooseUpload(original, { kind: 'encoded', bytes: original }, LIMIT)).toEqual({ send: 'original' });
    expect(chooseUpload(original, { kind: 'skipped' }, LIMIT)).toEqual({ send: 'original' });
  });

  it('sends the original when the device cannot encode and it fits, else fails as unsupported', () => {
    expect(chooseUpload(original, { kind: 'unsupported' }, LIMIT)).toEqual({ send: 'original' });
    expect(chooseUpload(LIMIT + 1, { kind: 'unsupported' }, LIMIT)).toEqual({ fail: 'unsupported' });
  });

  it('fails as too large when even the smaller file is over the limit', () => {
    expect(chooseUpload(3 * LIMIT, { kind: 'encoded', bytes: LIMIT + 1 }, LIMIT)).toEqual({ fail: 'tooLarge' });
    expect(chooseUpload(LIMIT + 1, { kind: 'skipped' }, LIMIT)).toEqual({ fail: 'tooLarge' });
  });

  it('names the limit in the message', () => {
    expect(videoLimitMessage('unsupported', LIMIT)).toBe("This device can't shrink this video; it's over the 10 MB limit.");
    expect(videoLimitMessage('tooLarge', LIMIT)).toContain('10 MB');
  });
});

describe('files', () => {
  it('re-encodes video types only', () => {
    expect(isVideoType('video/quicktime')).toBe(true);
    expect(isVideoType('image/png')).toBe(false);
    expect(isVideoType('')).toBe(false);
  });

  it('names the output after the original', () => {
    expect(mp4Name('IMG_0001.MOV')).toBe('IMG_0001.mp4');
    expect(mp4Name('clip.final.webm')).toBe('clip.final.mp4');
    expect(mp4Name('recording')).toBe('recording.mp4');
    expect(mp4Name('.hidden')).toBe('.hidden.mp4');
  });
});
