// Archive settings: sync pace, backfill, retention and caps. Stored JSON is normalized on read (see settings.ts).
import { bool, clampInt, clampNumber, isObj, oneOf } from './normalize';
import { THREAD_CHANNEL_TYPES, snowflakeToMs } from './discord';
import { MS_PER_DAY } from './units';
import type { ChannelInfo } from './types/archive';

export const BACKFILL_UNITS = ['days', 'months', 'years'] as const;
export type BackfillUnit = (typeof BACKFILL_UNITS)[number];
export type BackfillHistory = { unit: BackfillUnit; amount: number } | 'complete';
/** A channel's fixed starting time, captured when no earlier history is chosen. */
export type BackfillSince = { sinceMs: number };
export type ChannelBackfillHistory = BackfillHistory | BackfillSince;

/** The lowest snowflake, 0, encodes the earliest possible message time. */
export const EARLIEST_MESSAGE_MS = snowflakeToMs('0');

/** Bounded history choices keep the existing ten-year ceiling. Complete history has no depth limit. */
export const BACKFILL_MAX_YEARS = 10;
const DAYS_PER_COMMON_YEAR = 365;
const MONTHS_PER_YEAR = 12;
export const BACKFILL_AMOUNT_MIN = 1;
export const BACKFILL_AMOUNT_MAX: Record<BackfillUnit, number> = {
  days: BACKFILL_MAX_YEARS * DAYS_PER_COMMON_YEAR,
  months: BACKFILL_MAX_YEARS * MONTHS_PER_YEAR,
  years: BACKFILL_MAX_YEARS,
};
/** Initial backfill depth; user-adjustable in Settings. */
export const DEFAULT_BACKFILL_HISTORY = { unit: 'days', amount: 30 } as const satisfies BackfillHistory;

export const clampBackfillAmount = (unit: BackfillUnit, amount: unknown): number =>
  clampInt(amount, BACKFILL_AMOUNT_MIN, BACKFILL_AMOUNT_MAX[unit], Math.min(DEFAULT_BACKFILL_HISTORY.amount, BACKFILL_AMOUNT_MAX[unit]));

const readBackfillHistory = (v: unknown): BackfillHistory | undefined => {
  if (v === 'complete') return v;
  if (!isObj(v)) return undefined;
  const unit = oneOf(BACKFILL_UNITS, v['unit'], null);
  if (!unit || !Number.isFinite(Number(v['amount']))) return undefined;
  return { unit, amount: clampBackfillAmount(unit, v['amount']) };
};

/** Calendar subtraction uses UTC and clamps missing days to the target month's last day. */
export function backfillCutoffMs(history: ChannelBackfillHistory, now: number): number {
  if (history === 'complete') return EARLIEST_MESSAGE_MS;
  if ('sinceMs' in history) return history.sinceMs;
  if (history.unit === 'days') return now - history.amount * MS_PER_DAY;
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (history.unit === 'months') date.setUTCMonth(date.getUTCMonth() - history.amount);
  else date.setUTCFullYear(date.getUTCFullYear() - history.amount);
  const lastDay = new Date(date.getTime());
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return date.getTime();
}

/** Threads and forum posts use their parent; other channels, including DMs, use their own choice. */
export function resolveBackfillCutoffMs(settings: ArchiveSettings, channelId: string, now: number, channel?: Pick<ChannelInfo, 'kind' | 'parentId'> | null): number {
  const ownerId = channel && THREAD_CHANNEL_TYPES.has(channel.kind) ? channel.parentId ?? channelId : channelId;
  const history = Object.hasOwn(settings.channelBackfillHistory, ownerId) ? settings.channelBackfillHistory[ownerId] : undefined;
  return backfillCutoffMs(history ?? settings.backfillHistory, now);
}

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

/** Gentle pacing approximates scrolling history; Normal doubles it. Discord rate-limit headers and 429 backoff apply to both. */
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
  backfillHistory: BackfillHistory;
  /** Per-channel overrides; absent entries follow backfillHistory. Threads follow their parent. */
  channelBackfillHistory: Record<string, ChannelBackfillHistory>;
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

/** full retains captured payloads; compressed uses lossless zstd; summary-only removes covered text/payload while retaining citation rows. */
export const TEXT_TIERS = ['full', 'compressed', 'summary-only'] as const;
export type TextTier = (typeof TEXT_TIERS)[number];
/** A quarter: recent history keeps its full payload. */
const DEFAULT_TEXT_TIER_AFTER_DAYS = 90;
/** Keep full payloads for at least a day before applying their storage tier. */
export const TEXT_TIER_AFTER_DAYS_MIN = 1;
/** Ten years bounds the retention input while allowing long-lived full payloads. */
export const TEXT_TIER_AFTER_DAYS_MAX = 3650;
/** Smallest and largest database caps Settings accepts. */
export const TEXT_CAP_MIN_GB = 0.1;
export const TEXT_CAP_MAX_GB = 10_000;

/** Smallest and largest attachment caps Settings accepts. */
export const ATTACHMENT_CAP_MIN_GB = 1;
export const ATTACHMENT_CAP_MAX_GB = 100_000;

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
  backfillHistory: DEFAULT_BACKFILL_HISTORY,
  channelBackfillHistory: {},
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

const readChannelBackfillHistory = (v: unknown): ChannelBackfillHistory | undefined => {
  if (v === 'complete') return v;
  if (!isObj(v) || Array.isArray(v)) return undefined;
  if ('sinceMs' in v) {
    const sinceMs = normalizeTime(v['sinceMs']);
    return sinceMs === null ? undefined : { sinceMs };
  }
  const unit = oneOf(BACKFILL_UNITS, v['unit'], null);
  const amount = v['amount'];
  return unit && typeof amount === 'number' && Number.isInteger(amount) && amount >= BACKFILL_AMOUNT_MIN && amount <= BACKFILL_AMOUNT_MAX[unit]
    ? { unit, amount } : undefined;
};

const normalizeChannelBackfillHistory = (v: unknown): Record<string, ChannelBackfillHistory> => {
  if (!isObj(v) || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).flatMap(([id, value]) => {
    const history = readChannelBackfillHistory(value);
    return id && history !== undefined ? [[id, history]] : [];
  }));
};

export function normalizeArchiveSettings(v: unknown): ArchiveSettings {
  const src = isObj(v) ? v : {};
  const d = DEFAULT_ARCHIVE_SETTINGS;
  return {
    backfillHistory: readBackfillHistory(src['backfillHistory']) ?? readBackfillHistory({ unit: 'days', amount: src['backfillDays'] }) ?? DEFAULT_BACKFILL_HISTORY,
    channelBackfillHistory: normalizeChannelBackfillHistory(src['channelBackfillHistory']),
    syncPace: oneOf(SYNC_PACES, src['syncPace'], d.syncPace),
    syncEnabled: bool(src['syncEnabled'], d.syncEnabled),
    attachmentCapGb: normalizeCap(src['attachmentCapGb'], ATTACHMENT_CAP_MIN_GB, ATTACHMENT_CAP_MAX_GB),
    textTier: oneOf(TEXT_TIERS, src['textTier'], d.textTier),
    textTierAfterDays: clampInt(src['textTierAfterDays'], TEXT_TIER_AFTER_DAYS_MIN, TEXT_TIER_AFTER_DAYS_MAX, DEFAULT_TEXT_TIER_AFTER_DAYS),
    textCapGb: normalizeCap(src['textCapGb'], TEXT_CAP_MIN_GB, TEXT_CAP_MAX_GB),
    reverifyChannelIds: Array.isArray(src['reverifyChannelIds']) ? src['reverifyChannelIds'].filter((x): x is string => typeof x === 'string') : [],
    reverifyDays: clampInt(src['reverifyDays'], REVERIFY_DAYS_MIN, REVERIFY_DAYS_MAX, DEFAULT_REVERIFY_DAYS),
    automaticPostPauseS: clampNumber(src['automaticPostPauseS'], AUTOMATIC_POST_PAUSE_MIN_S, AUTOMATIC_POST_PAUSE_MAX_S, DEFAULT_AUTOMATIC_POST_PAUSE_S),
    autoArchiveSinceMs: normalizeTime(src['autoArchiveSinceMs']),
  };
}
