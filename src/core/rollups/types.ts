import type { ArchiveChangeKind } from '@shared/contract';
import type { ArchiveRead } from '../plugins/pluginDb';
import type { RollupStatus } from '@shared/rollups';
import type { ReadFold } from '../reads/protocol';
export type { RollupStatus } from '@shared/rollups';

/** UTC partitions remain stable across viewer and operating-system time-zone changes. */
export interface RollupPartition { channelId: string; day: string; startTs: number; endTs: number; timeZone: string }
export type RollupRow = Record<string, string | number | null>;
export interface RollupSpec<R extends object, D = undefined> {
  version: number;
  columns: Record<keyof R & string, 'TEXT' | 'INTEGER' | 'REAL'>;
  key: readonly (keyof R & string)[];
  indexes?: readonly (readonly (keyof R & string)[])[];
  /** A changed message invalidates every UTC day of an overlapping stored run, including possible split openers. */
  span?: { start: keyof R & string; end: keyof R & string; paddingMs: number };
  /** Optional materialized fold across days, retaining channel privacy and the partition's key grain. */
  allTime?: { values: ReadFold['values']; orderBy?: keyof R & string };
  dependsOn: readonly ArchiveChangeKind[];
  timeZoneSensitive?: boolean;
  /** Structured-cloneable configuration; compute cannot capture imports, module variables or the plugin context. */
  data?: D;
  /** Runs wholly in a read-pool worker, with a single committed snapshot and background-priority reads. */
  compute: (part: RollupPartition, read: ArchiveRead, signal: AbortSignal, data: D) => Promise<R[]>;
}
export interface Rollup {
  readonly view: string;
  readonly allTimeView: string | null;
  status(): RollupStatus;
  /** Opaque clean-build token for the requested channels and opener days. Recheck after reads; changed tokens require a retry. */
  snapshot(scope?: { channelIds?: readonly string[]; firstDay?: string }): string | null;
  /** Explicit dependencies outside the changed message's day, such as a conversation's opener partition. */
  markDirty(partitions: readonly { channelId: string; day: string }[]): void;
  rebuild(scope?: { channelIds?: readonly string[] }): void;
}
export interface PluginRollups {
  define<R extends object, D = undefined>(name: string, spec: RollupSpec<R, D>): Rollup;
}
/** Synthetic benchmarks compare every panel read with the 100 ms perceived-instant threshold. */
export const ROLLUP_READ_BUDGET_MS = 100;
