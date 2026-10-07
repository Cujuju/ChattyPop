import { PACE_TIMING, SETTINGS_KEYS, WAIT_JITTER, normalizeArchiveSettings, type ArchiveSettings, type PaceTiming } from '@shared/settings';
import { sleep } from '@shared/async';
import { MS_PER_S } from '@shared/units';
import type { CoreClient } from '../coreClient';

/** Settings changes take effect within this long without a restart. */
const SETTINGS_REFRESH_MS = 30 * MS_PER_S;

/** Archive settings as stored now (no caching). */
export const readArchiveSettings = async (core: CoreClient): Promise<ArchiveSettings> => normalizeArchiveSettings(await core.call('getSetting', SETTINGS_KEYS.archive));

/** Pace and the background-sync switch from Archive settings, re-read periodically. */
export class Pace {
  private settings: ArchiveSettings | undefined;
  private readAt = 0;

  constructor(private readonly core: CoreClient) {}

  private async archive(): Promise<ArchiveSettings> {
    if (!this.settings || Date.now() - this.readAt > SETTINGS_REFRESH_MS) {
      this.readAt = Date.now();
      this.settings = await readArchiveSettings(this.core);
    }
    return this.settings;
  }

  async current(): Promise<PaceTiming> {
    return PACE_TIMING[(await this.archive()).syncPace];
  }

  async syncEnabled(): Promise<boolean> {
    return (await this.archive()).syncEnabled;
  }

  /** An automatic post's one wait: the owner's setting, randomized ± WAIT_JITTER. */
  async humanPause(): Promise<void> {
    await sleep(await this.automaticPauseMs());
  }

  /** The owner's automatic-post pause in ms, randomized ± WAIT_JITTER: also the least gap between automatic actions. */
  async automaticPauseMs(): Promise<number> {
    return jittered((await this.archive()).automaticPostPauseS * MS_PER_S, WAIT_JITTER);
  }
}

/** A gap of `meanMs` ± `jitter`, uniformly random. */
export const jittered = (meanMs: number, jitter: number): number => meanMs * (1 - jitter + Math.random() * 2 * jitter);
