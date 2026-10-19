import type { ArchiveChange, ArchiveChangeKind } from './types/ipc';

export interface ArchiveChangeOptions {
  insertOnly?: boolean;
  seq?: number;
  day?: string;
  pluginId?: string;
  nameGuildIds?: readonly string[];
}
export type NoteArchiveChange = (channelId: string, kinds: readonly ArchiveChangeKind[], opts?: ArchiveChangeOptions) => void;

/** Merges batches conservatively: one existing-row write invalidates a channel's insert-only classification. */
export class ArchiveChanges {
  private readonly channels = new Map<string, Set<ArchiveChangeKind>>();
  private readonly refresh = new Set<string>();
  private readonly plugins = new Set<string>();
  private names: Set<string> | null = new Set();
  private inserted: ArchiveChange['inserted'];
  /** Dirty UTC partitions retained separately from the public event for rollup consumers. */
  private readonly touched = new Map<string, Set<string>>();

  add(channelId: string, kinds: readonly ArchiveChangeKind[], opts: ArchiveChangeOptions = {}): void {
    if (!kinds.length) return;
    const found = this.channels.get(channelId) ?? new Set();
    kinds.forEach((kind) => found.add(kind));
    this.channels.set(channelId, found);
    if (!opts.insertOnly || kinds.some((k) => !['messages', 'attachments', 'links', 'reactions'].includes(k))) this.refresh.add(channelId);
    if (opts.seq !== undefined) {
      this.inserted = {
        afterSeq: Math.min(this.inserted?.afterSeq ?? opts.seq, opts.seq - 1),
        throughSeq: Math.max(this.inserted?.throughSeq ?? opts.seq, opts.seq),
      };
    }
    if (opts.day && channelId) {
      const days = this.touched.get(channelId) ?? new Set();
      days.add(opts.day);
      this.touched.set(channelId, days);
    }
    if (opts.pluginId) this.plugins.add(opts.pluginId);
    if (kinds.includes('names')) {
      if (!opts.nameGuildIds) this.names = null;
      else opts.nameGuildIds.forEach((id) => this.names?.add(id));
    }
  }

  merge(change: ArchiveChange): void {
    for (const [id, kinds] of Object.entries(change.changes)) {
      this.add(id, kinds, { insertOnly: change.insertOnlyChannelIds.includes(id), nameGuildIds: change.nameGuildIds });
    }
    change.pluginIds?.forEach((id) => this.plugins.add(id));
    if (change.inserted) this.inserted = {
      afterSeq: Math.min(this.inserted?.afterSeq ?? change.inserted.afterSeq, change.inserted.afterSeq),
      throughSeq: Math.max(this.inserted?.throughSeq ?? change.inserted.throughSeq, change.inserted.throughSeq),
    };
  }

  take(): ArchiveChange {
    const changes = Object.fromEntries([...this.channels].map(([id, kinds]) => [id, [...kinds]]));
    const result: ArchiveChange = {
      changes,
      insertOnlyChannelIds: [...this.channels.keys()].filter((id) => id !== '' && !this.refresh.has(id)),
      ...(this.inserted ? { inserted: this.inserted } : {}),
      ...(this.plugins.size ? { pluginIds: [...this.plugins] } : {}),
      ...(this.names?.size ? { nameGuildIds: [...this.names] } : {}),
    };
    this.channels.clear();
    this.refresh.clear();
    this.plugins.clear();
    this.names = new Set();
    this.inserted = undefined;
    return result;
  }

  takeTouched(): { channelId: string; utcDay: string }[] {
    const result = [...this.touched].flatMap(([channelId, days]) => [...days].map((utcDay) => ({ channelId, utcDay })));
    this.touched.clear();
    return result;
  }
}
