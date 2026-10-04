// Archive settings: sync pace, backfill, retention and caps. Stored JSON is normalized on read (see settings.ts).
import { bool, clampInt, clampNumber, isObj, oneOf } from './normalize';

export const SYNC_PACES = ['gentle', 'normal'] as const;
export type SyncPace = (typeof SYNC_PACES)[number];

export interface PaceTiming {
  /** Mean gap between Discord API requests (history pages). */
  apiMs: number;
  /** Mean gap between attachment downloads from Discord's CDN. */
  mediaMs: number;
  /** Each gap is randomized by ± this fraction so requests don't form a machine-regular rhythm. */
  jitter: number;
}

/** Every randomized wait varies by ± this fraction, so requests don't form a machine-regular rhythm. */
export const WAIT_JITTER = 0.35;

/**
 * Gentle ≈ a person scrolling back through history (a page every few seconds, images as they appear).
 * Normal is roughly twice as fast. Discord's rate-limit headers and 429 backoff apply on top of both.
 */
export const PACE_TIMING: Record<SyncPace, PaceTiming> = {
  gentle: { apiMs: 3000, mediaMs: 1500, jitter: WAIT_JITTER },
  normal: { apiMs: 1500, mediaMs: 500, jitter: WAIT_JITTER },
};

/** The earlier fixed pause averaged 2 s (1–3 s): about a person's quickest considered reply. */
const DEFAULT_AUTOMATIC_POST_PAUSE_S = 2;
/** A person can't answer within milliseconds of a post; below a second reads as automated. */
export const AUTOMATIC_POST_PAUSE_MIN_S = 1;
/** A minute: past this an answer stops reading as a reply to what was said. */
export const AUTOMATIC_POST_PAUSE_MAX_S = 60;

/** The pause range an automatic post can get, in seconds: the setting ± WAIT_JITTER. */
export const automaticPostPauseRange = (s: number): { min: number; max: number } => ({ min: s * (1 - WAIT_JITTER), max: s * (1 + WAIT_JITTER) });

export interface ArchiveSettings {
  /** How far back a newly opted-in channel is backfilled. */
  backfillDays: number;
  syncPace: SyncPace;
  /** Background catch-up and backfill. Live capture from the open client is passive and unaffected. */
  syncEnabled: boolean;
  /** Attachment files kept on disk, in GB; the oldest are pruned beyond it. null = keep everything. */
  attachmentCapGb: number | null;
  /** How messages older than `textTierAfterDays` are stored (see TextTier). */
  textTier: TextTier;
  textTierAfterDays: number;
  /** Database size limit in GB: beyond it the oldest messages are compressed, then pruned if the tier allows. null = no limit. */
  textCapGb: number | null;
  /** Channels whose recent history is fetched again at startup, to catch edits and deletes made while the app was closed. */
  reverifyChannelIds: string[];
  /** How far back that startup re-check reaches. */
  reverifyDays: number;
  /** Mean pause before an automatic post (plugins' replies and posts), in seconds; each is randomized ± WAIT_JITTER. */
  automaticPostPauseS: number;
  /** When "Archive DMs automatically" was turned on (ms): a DM's message after it archives the DM. null = off. */
  autoArchiveSinceMs: number | null;
}

/** A long weekend closed; a few pages per busy channel. */
const DEFAULT_REVERIFY_DAYS = 3;
export const REVERIFY_DAYS_MIN = 1;
/** Each re-checked day is re-fetched every start; beyond a month the cost outweighs catching old edits. */
export const REVERIFY_DAYS_MAX = 30;

/**
 * full: kept as captured. compressed: the raw Discord payload is zstd-compressed (lossless, about half the size).
 * summary-only: compressed, and once an active coverage provider covers a message its text and payload are removed; the row stays so citations resolve.
 */
export const TEXT_TIERS = ['full', 'compressed', 'summary-only'] as const;
export type TextTier = (typeof TEXT_TIERS)[number];
/** A quarter: recent history keeps its full payload. */
const DEFAULT_TEXT_TIER_AFTER_DAYS = 90;
/** Smallest and largest database caps Settings accepts. */
export const TEXT_CAP_MIN_GB = 0.1;
export const TEXT_CAP_MAX_GB = 10_000;

/** Smallest and largest attachment caps Settings accepts. */
export const ATTACHMENT_CAP_MIN_GB = 1;
export const ATTACHMENT_CAP_MAX_GB = 100_000;

/** Initial backfill depth; user-adjustable in Settings. */
const DEFAULT_BACKFILL_DAYS = 30;
export const BACKFILL_DAYS_MIN = 1;
/** Ten years: far beyond any server's useful history, bounds the input. */
export const BACKFILL_DAYS_MAX = 3650;

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
  backfillDays: DEFAULT_BACKFILL_DAYS,
  syncPace: 'gentle',
  syncEnabled: true,
  attachmentCapGb: null,
  textTier: 'full',
  textTierAfterDays: DEFAULT_TEXT_TIER_AFTER_DAYS,
  textCapGb: null,
  reverifyChannelIds: [],
  reverifyDays: DEFAULT_REVERIFY_DAYS,
  automaticPostPauseS: DEFAULT_AUTOMATIC_POST_PAUSE_S,
  autoArchiveSinceMs: null,
};

/** null/undefined, unreadable or ≤ 0 = null (no cap); else clamped to [min, max], not rounded. */
const normalizeCap = (v: unknown, min: number, max: number): number | null => {
  const gb = Number(v);
  return v === null || v === undefined || !Number.isFinite(gb) || gb <= 0 ? null : Math.min(max, Math.max(min, gb));
};
/** A stored time (ms): finite and positive, else null. */
const normalizeTime = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const normalizeDays = (v: unknown, fallback: number): number => clampInt(v, BACKFILL_DAYS_MIN, BACKFILL_DAYS_MAX, fallback);

export function normalizeArchiveSettings(v: unknown): ArchiveSettings {
  const src = isObj(v) ? v : {};
  const d = DEFAULT_ARCHIVE_SETTINGS;
  return {
    backfillDays: normalizeDays(src['backfillDays'], DEFAULT_BACKFILL_DAYS),
    syncPace: oneOf(SYNC_PACES, src['syncPace'], d.syncPace),
    syncEnabled: bool(src['syncEnabled'], d.syncEnabled),
    attachmentCapGb: normalizeCap(src['attachmentCapGb'], ATTACHMENT_CAP_MIN_GB, ATTACHMENT_CAP_MAX_GB),
    textTier: oneOf(TEXT_TIERS, src['textTier'], d.textTier),
    textTierAfterDays: normalizeDays(src['textTierAfterDays'], DEFAULT_TEXT_TIER_AFTER_DAYS),
    textCapGb: normalizeCap(src['textCapGb'], TEXT_CAP_MIN_GB, TEXT_CAP_MAX_GB),
    reverifyChannelIds: Array.isArray(src['reverifyChannelIds']) ? src['reverifyChannelIds'].filter((x): x is string => typeof x === 'string') : [],
    reverifyDays: clampInt(src['reverifyDays'], REVERIFY_DAYS_MIN, REVERIFY_DAYS_MAX, DEFAULT_REVERIFY_DAYS),
    automaticPostPauseS: clampNumber(src['automaticPostPauseS'], AUTOMATIC_POST_PAUSE_MIN_S, AUTOMATIC_POST_PAUSE_MAX_S, DEFAULT_AUTOMATIC_POST_PAUSE_S),
    autoArchiveSinceMs: normalizeTime(src['autoArchiveSinceMs']),
  };
}
