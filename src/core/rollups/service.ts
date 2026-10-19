import type { AppEvent, ArchiveChangeKind } from '@shared/contract';
import type { ArchiveChangeOptions } from '@shared/archiveChanges';
import { MS_PER_MIN, MS_PER_S } from '@shared/units';
import { PluginInactiveError } from '@shared/pluginCall';
import type { Db } from '../db';
import { computeArchive, readArchive } from '../reads/archiveReads';
import { installRollupStore, markPartitions, PARTITIONS_SQL, partition, replacePartition, rollupTable, type Dirty, type Meta } from './store';
import type { PluginRollups, Rollup, RollupRow, RollupSpec, RollupStatus } from './types';
import { installRollupTriggers } from './triggers';
import { referenceWorkPending, seedRollupReferences } from './privacy';
import { metadataAffects, metadataPending, seedRollupMetadata } from './metadata';
import type { FoldResult } from '../reads/protocol';
import { ARCHIVE_REFRESH_DEBOUNCE_MS } from '@shared/archiveRefresh';
import { spanGeneration } from './spans';
import { pendingChangesSql, seedRollupChanges } from './changes';
import { publishMaterializedFold } from './materialized';

/** Retry cancelled reads and transient archive moves without spinning on unavailable files. */
const RETRY_MS = MS_PER_S;
/** Operating-system zone changes have no app event; check once a minute and before status reads. */
const ZONE_CHECK_MS = MS_PER_MIN;
const services = new WeakMap<Db, Set<MaintainedRollup>>();
const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
// These changes already have durable trigger marks; notifications only wake their consumers.
const TRIGGER_KINDS = new Set<ArchiveChangeKind>(['messages', 'edits', 'deletes', 'attachments', 'links', 'names', 'channels']);

/** Called at the mutation boundary, before the renderer's debounced change event. Dirty work survives a crash. */
export function noteRollupChange(db: Db, channelId: string, kinds: readonly ArchiveChangeKind[], opts: ArchiveChangeOptions = {}): void {
  for (const service of services.get(db) ?? []) service.changed(channelId, kinds, opts.day);
}

export function pluginRollups(db: () => Db, pluginId: string, signal: AbortSignal, resumed: boolean, emit: (e: AppEvent) => void): PluginRollups {
  const defined = new Set<string>();
  return {
    define: (name, spec) => {
      signal.throwIfAborted();
      if (defined.has(name)) throw new Error(`${pluginId} already defines rollup ${name}`);
      defined.add(name);
      return new MaintainedRollup(db, pluginId, name, spec as RollupSpec<RollupRow, unknown>, signal, resumed, emit);
    },
  };
}

class MaintainedRollup implements Rollup {
  readonly view: string;
  readonly allTimeView: string | null;
  readonly foldView: string | null;
  private readonly id: string;
  private readonly table: string;
  private readonly source: string;
  private running = false;
  private timer?: NodeJS.Timeout;
  private error: string | null = null;
  private zone = systemZone();
  private epoch = 0;
  private progressAt = -Infinity;

  constructor(private readonly ready: () => Db, private readonly pluginId: string, private readonly name: string,
    private readonly spec: RollupSpec<RollupRow, unknown>, private readonly signal: AbortSignal,
    resumed: boolean, private readonly emit: (event: AppEvent) => void) {
    const db = ready();
    installRollupStore(db);
    installRollupTriggers(db);
    this.id = `${pluginId}.${name}`;
    this.table = rollupTable(db, pluginId, name, spec);
    this.view = `${this.table}_visible`;
    this.allTimeView = spec.allTime ? `${this.table}_all_time_visible` : null;
    this.foldView = spec.fold ? `${this.table}_folded_visible` : null;
    this.source = spec.compute.toString().replace(/^(async\s+)?compute\s*\(/, '$1function compute(');
    db.transaction(() => {
      db.prepare('DELETE FROM rollup_kinds WHERE rollup = ?').run(this.id);
      for (const kind of spec.dependsOn) db.prepare('INSERT INTO rollup_kinds VALUES (?, ?)').run(this.id, kind);
    })();
    const meta = this.meta();
    db.prepare(`INSERT INTO rollup_meta(rollup, version, zone) VALUES (?, ?, ?) ON CONFLICT(rollup) DO NOTHING`).run(this.id, spec.version, this.zone);
    if (!resumed || !meta || meta.version !== spec.version || (spec.timeZoneSensitive && meta.zone !== this.zone)) this.invalidate();
    const active = services.get(db) ?? new Set();
    if ([...active].some((service) => service.id === this.id)) throw new Error(`Rollup ${this.id} already active`);
    active.add(this);
    services.set(db, active);
    const zoneTimer = setInterval(() => this.checkZone(), ZONE_CHECK_MS).unref();
    signal.addEventListener('abort', () => { active.delete(this); clearTimeout(this.timer); clearInterval(zoneTimer); this.epoch++; }, { once: true });
    // Activation may still be in the host's registration transaction.
    this.schedule();
  }

  private meta(): Meta | undefined {
    return this.ready().prepare('SELECT version, zone, revision, built_through_seq, queued_through_seq, backfill FROM rollup_meta WHERE rollup = ?').get(this.id) as Meta | undefined;
  }

  private invalidate(): void {
    this.epoch++;
    this.ready().prepare('UPDATE rollup_meta SET version = ?, zone = ?, backfill = 1, built_through_seq = 0, revision = revision + 1 WHERE rollup = ?').run(this.spec.version, this.zone, this.id);
  }

  private checkZone(): void {
    if (this.signal.aborted || !this.spec.timeZoneSensitive || !this.ready().open) return;
    const zone = systemZone();
    if (zone !== this.zone) { this.zone = zone; this.invalidate(); this.schedule(); this.progress(); }
  }

  status(): RollupStatus {
    if (this.signal.aborted) throw new PluginInactiveError(this.pluginId);
    this.checkZone();
    const { dirty } = this.ready().prepare(`SELECT COUNT(*) AS dirty FROM (
      SELECT channel_id, day FROM rollup_dirty WHERE rollup = ? UNION
      SELECT c.channel_id, c.day FROM rollup_changes c JOIN rollup_kinds k ON k.kind = c.kind WHERE k.rollup = ?)`)
      .get(this.id, this.id) as { dirty: number };
    const { spans } = this.ready().prepare('SELECT COUNT(*) AS spans FROM rollup_span_dirty WHERE rollup = ?').get(this.id) as { spans: number };
    const folds = this.ready().prepare('SELECT COUNT(*) FROM rollup_fold_dirty WHERE rollup = ?').pluck().get(this.id) as number;
    const referencesPending = referenceWorkPending(this.ready()) || metadataPending(this.ready());
    if ((dirty || spans || folds || referencesPending) && !this.running) this.schedule();
    const { total } = this.ready().prepare(`SELECT COUNT(*) AS total FROM (
      SELECT channel_id, day FROM rollup_partitions WHERE rollup = ? UNION SELECT channel_id, day FROM rollup_dirty WHERE rollup = ? UNION
      SELECT c.channel_id, c.day FROM rollup_changes c JOIN rollup_kinds k ON k.kind = c.kind WHERE k.rollup = ?)`)
      .get(this.id, this.id, this.id) as { total: number };
    return { building: Boolean(referencesPending || this.meta()?.backfill || dirty || spans || folds || this.running), dirty: dirty + spans + folds, total, error: this.error };
  }

  snapshot(scope?: { channelIds?: readonly string[]; firstDay?: string }): string | null {
    this.signal.throwIfAborted();
    this.checkZone();
    if (metadataAffects(this.ready(), this.id)) { this.schedule(); return null; }
    const row = this.ready().prepare(`SELECT m.version, m.zone, m.revision, r.revision AS references_revision, v.revision AS visibility_revision
      FROM rollup_meta m JOIN rollup_reference_state r ON r.singleton = 1
        JOIN rollup_visibility_state v ON v.singleton = 1
      WHERE m.rollup = @rollup AND m.backfill = 0 AND r.ready = 1
        AND NOT EXISTS (SELECT 1 FROM rollup_fold_dirty f WHERE f.rollup = m.rollup
          AND (@channels IS NULL OR f.channel_id IN (SELECT value FROM json_each(@channels))))
        AND NOT ${pendingChangesSql('m.rollup', undefined, undefined, '@first', '@channels')}
        AND NOT EXISTS (SELECT 1 FROM rollup_dirty WHERE rollup = m.rollup
          AND (@channels IS NULL OR channel_id IN (SELECT value FROM json_each(@channels)))
          AND (@first IS NULL OR day = '' OR day >= @first))
        AND NOT EXISTS (SELECT 1 FROM rollup_span_dirty WHERE rollup = m.rollup
          AND (@channels IS NULL OR channel_id IN (SELECT value FROM json_each(@channels)))
          AND (@first IS NULL OR last_day >= @first))`)
      .get({ rollup: this.id, channels: scope?.channelIds ? JSON.stringify(scope.channelIds) : null, first: scope?.firstDay ?? null }) as { version: number; zone: string; revision: number; references_revision: number; visibility_revision: number } | undefined;
    if (!row) { this.schedule(); return null; }
    return `${row.version}:${row.revision}:${row.references_revision}:${row.visibility_revision}:${row.zone}`;
  }

  rebuild(scope?: { channelIds?: readonly string[] }): void {
    this.signal.throwIfAborted();
    this.error = null;
    if (!scope?.channelIds) this.invalidate();
    else {
      // Persist the request synchronously; enumeration and archive scans remain off Core's thread.
      this.ready().prepare(`INSERT INTO rollup_dirty(rollup, channel_id, day) SELECT ?, value, '' FROM json_each(?)
        WHERE 1 ON CONFLICT(rollup, channel_id, day) DO UPDATE SET revision = revision + 1`).run(this.id, JSON.stringify(scope.channelIds));
      this.epoch++;
    }
    this.schedule();
    this.progress(true);
  }

  markDirty(parts: readonly { channelId: string; day: string }[]): void {
    this.signal.throwIfAborted();
    for (const part of parts) {
      const parsed = partition(part.channelId, part.day, this.zone);
      if (!part.channelId || new Date(parsed.startTs).toISOString().slice(0, 10) !== part.day) throw new Error('Invalid rollup partition');
    }
    markPartitions(this.ready(), this.id, parts.map((part) => ({ channel_id: part.channelId, day: part.day })));
    this.schedule();
    this.progress();
  }

  changed(channelId: string, kinds: readonly ArchiveChangeKind[], day?: string): void {
    if (this.signal.aborted) return;
    // Shared trigger/reference queues are probed once during the drain, not once per arriving message.
    this.schedule();
    const matched = kinds.filter((kind) => this.spec.dependsOn.includes(kind));
    if (!matched.length) return;
    if (matched.every((kind) => TRIGGER_KINDS.has(kind))) return;
    if (channelId && day) markPartitions(this.ready(), this.id, [{ channel_id: channelId, day }]);
    else if (channelId) this.rebuild({ channelIds: [channelId] });
    else this.invalidate();
    this.schedule();
  }

  private schedule(delay = 0): void {
    if (this.signal.aborted || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, delay).unref();
  }

  private async discover(full: boolean, epoch: number): Promise<void> {
    const db = this.ready();
    const scopes = db.prepare("SELECT channel_id, revision FROM rollup_dirty WHERE rollup = ? AND day = ''").all(this.id) as { channel_id: string; revision: number }[];
    if (!full && !scopes.length) return;
    const [discovered] = await readArchive<{ watermark: number; partitions: string }>(db, `SELECT
      (SELECT COALESCE(MAX(seq), 0) FROM messages) AS watermark,
      json_group_array(json_object('channel_id', channel_id, 'day', day)) AS partitions FROM (
        SELECT DISTINCT channel_id, day FROM (${PARTITIONS_SQL})
        WHERE @full OR channel_id IN (SELECT value FROM json_each(@scopes)) ORDER BY day DESC)`,
      { rollup: this.id, full: Number(full), scopes: JSON.stringify(scopes.map((s) => s.channel_id)) }, this.signal, 'background');
    if (this.signal.aborted || epoch !== this.epoch || db !== this.ready()) return;
    db.transaction(() => {
      markPartitions(db, this.id, JSON.parse(discovered!.partitions) as { channel_id: string; day: string }[]);
      for (const scope of scopes) db.prepare("DELETE FROM rollup_dirty WHERE rollup = ? AND channel_id = ? AND day = '' AND revision = ?").run(this.id, scope.channel_id, scope.revision);
      if (full) db.prepare('UPDATE rollup_meta SET backfill = 0 WHERE rollup = ?').run(this.id);
      // Queued coverage survives partial builds; using only completed coverage would enqueue finished partitions again after restart.
      db.prepare('UPDATE rollup_meta SET queued_through_seq = MAX(queued_through_seq, ?) WHERE rollup = ?').run(discovered!.watermark, this.id);
    })();
  }

  private async drain(): Promise<void> {
    if (this.running || this.signal.aborted) return;
    this.running = true;
    try {
      const referencesPending = referenceWorkPending(this.ready()) || metadataPending(this.ready());
      if (!await seedRollupReferences(this.ready(), this.signal) || !await seedRollupMetadata(this.ready(), this.signal)) { this.schedule(); return; }
      if (referencesPending) for (const service of services.get(this.ready()) ?? []) if (service !== this) service.schedule();
      const meta = this.meta()!;
      await this.discover(Boolean(meta.backfill), this.epoch);
      while (!this.signal.aborted) {
        await seedRollupChanges(this.ready(), this.signal);
        if (this.meta()?.backfill) { this.schedule(); break; }
        await this.expandSpans();
        const db = this.ready();
        const dirty = db.prepare("SELECT channel_id, day, revision FROM rollup_dirty WHERE rollup = ? AND day != '' ORDER BY day DESC, channel_id LIMIT 1").get(this.id) as Dirty | undefined;
        if (!dirty) { if (await this.foldChannel()) continue; break; }
        const epoch = this.epoch;
        const generation = this.spec.span ? spanGeneration(db, this.id, dirty.channel_id) : 0;
        const [computed] = await computeArchive<{ rows: RollupRow[]; watermark: number; fold?: FoldResult }>(db, {
          source: this.source, partition: partition(dirty.channel_id, dirty.day, this.zone), data: this.spec.data,
          fold: this.spec.allTime ? { table: this.table, keys: [...this.spec.key], ...this.spec.allTime } : undefined,
        }, this.signal);
        if (this.signal.aborted || epoch !== this.epoch || db !== this.ready()) { this.schedule(); break; }
        if (this.spec.span && generation !== spanGeneration(db, this.id, dirty.channel_id)) continue;
        replacePartition(db, this.id, this.table, dirty, Object.keys(this.spec.columns), computed!.rows, computed!.watermark, computed!.fold, Boolean(this.spec.fold));
        this.error = null;
        this.progress();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.error = null;
    } catch (error) {
      if (!this.signal.aborted) { this.error = (error as Error).message; this.schedule(RETRY_MS); }
    } finally {
      this.running = false;
      if (!this.signal.aborted && this.ready().open) this.progress(true);
    }
  }

  private async foldChannel(): Promise<boolean> {
    if (!this.spec.fold) return false;
    const db = this.ready(), epoch = this.epoch, meta = this.meta()!;
    const pending = db.prepare('SELECT channel_id, revision FROM rollup_fold_dirty WHERE rollup = ? LIMIT 1').get(this.id) as { channel_id: string; revision: number } | undefined;
    if (!pending) return false;
    const [computed] = await computeArchive<{ rows: RollupRow[] }>(db, {
      source: this.spec.fold.compute.toString().replace(/^(async\s+)?compute\s*\(/, '$1function compute('),
      partition: pending.channel_id, data: { table: this.table, config: this.spec.fold.data },
    }, this.signal);
    const current = () => !this.signal.aborted && db === this.ready() && epoch === this.epoch
      && meta.revision === this.meta()!.revision && !metadataAffects(db, this.id)
      && !db.prepare(`SELECT ${pendingChangesSql('?', '?')}`).pluck().get(this.id, pending.channel_id)
      && !db.prepare('SELECT 1 FROM rollup_dirty WHERE rollup = ? AND channel_id = ? LIMIT 1').get(this.id, pending.channel_id);
    if (!current()) return !this.signal.aborted && epoch === this.epoch;
    await publishMaterializedFold(db, this.id, this.table, this.spec.fold, pending.channel_id, pending.revision, computed!.rows, current);
    return true;
  }

  private async expandSpans(): Promise<void> {
    const db = this.ready();
    if (!db.prepare('SELECT 1 FROM rollup_span_dirty WHERE rollup = ? LIMIT 1').get(this.id)) return;
    const [result] = await readArchive<{ requests: string; partitions: string }>(db, `WITH RECURSIVE
      pending AS (SELECT channel_id, first_day, last_day, revision FROM rollup_span_dirty WHERE rollup = ?),
      days(channel_id, day, last) AS (
        SELECT channel_id, first_day, last_day FROM pending
        UNION ALL SELECT channel_id, date(day, '+1 day'), last FROM days WHERE day < last)
      SELECT (SELECT json_group_array(json_object('channel', channel_id, 'first', first_day, 'last', last_day, 'revision', revision)) FROM pending) AS requests,
        (SELECT json_group_array(json_object('channel_id', channel_id, 'day', day)) FROM (SELECT DISTINCT channel_id, day FROM days)) AS partitions`, [this.id], this.signal, 'background');
    if (this.signal.aborted || db !== this.ready()) return;
    db.transaction(() => {
      markPartitions(db, this.id, JSON.parse(result!.partitions));
      const remove = db.prepare('DELETE FROM rollup_span_dirty WHERE rollup = ? AND channel_id = ? AND first_day = ? AND last_day = ? AND revision = ?');
      for (const r of JSON.parse(result!.requests)) remove.run(this.id, r.channel, r.first, r.last, r.revision);
    })();
  }

  private progress(force = false): void {
    if (!force && performance.now() - this.progressAt < ARCHIVE_REFRESH_DEBOUNCE_MS) return;
    this.progressAt = performance.now();
    if (!this.signal.aborted && this.ready().open) this.emit({ type: 'rollup-progress', pluginId: this.pluginId, name: this.name, ...this.status() });
  }
}
