import type { ArchiveChange, ArchiveChangeKind } from './types/ipc';

export interface ArchiveChangeOptions {
  insertOnly?: boolean;
  seq?: number;
  day?: string;
  pluginId?: string;
  nameGuildIds?: readonly string[];
}

/**
 * Which rows a change touched: named messages of a channel, or every row of it (or, channel '', of the archive) when the
 * change can't name them. Views re-read only named rows.
 */
export type ChangedRows = { channelId: string; messageIds: readonly string[] } | { channelId: string; allRows: true };

/** Messages `messageIds` of `channelId` changed. */
export const changedMessages = (channelId: string, messageIds: readonly string[]): ChangedRows => ({ channelId, messageIds });
/** Any row of `channelId` ('' for the whole archive) may have changed. */
export const wholeChannel = (channelId: string): ChangedRows => ({ channelId, allRows: true });

export type NoteArchiveChange = (rows: ChangedRows, kinds: readonly ArchiveChangeKind[], opts?: ArchiveChangeOptions) => void;

/** Ids one event names per channel at most (about 20 bytes each, so under half a megabyte); past it the channel reads as changed throughout. */
export const NAMED_ROWS_MAX = 20_000;

/** Merges batches conservatively: one existing-row write invalidates a channel's insert-only classification. */
export class ArchiveChanges {
  private readonly channels = new Map<string, Set<ArchiveChangeKind>>();
  private readonly refresh = new Set<string>();
  private readonly plugins = new Set<string>();
  /** Per channel, the messages its changes named; null once one couldn't name them. */
  private readonly rows = new Map<string, Set<string> | null>();
  private names: Set<string> | null = new Set();
  private inserted: ArchiveChange['inserted'];
  /** Dirty UTC partitions retained separately from the public event for rollup consumers. */
  private readonly touched = new Map<string, Set<string>>();

  add(rows: ChangedRows, kinds: readonly ArchiveChangeKind[], opts: ArchiveChangeOptions = {}): void {
    if (!kinds.length) return;
    const { channelId } = rows;
    const found = this.channels.get(channelId) ?? new Set();
    kinds.forEach((kind) => found.add(kind));
    this.channels.set(channelId, found);
    this.addRows(rows);
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

  private addRows(rows: ChangedRows): void {
    const prior = this.rows.get(rows.channelId);
    if (prior === null) return;
    if (!('messageIds' in rows)) {
      this.rows.set(rows.channelId, null);
      return;
    }
    const named = prior ?? new Set<string>();
    rows.messageIds.forEach((id) => named.add(id));
    this.rows.set(rows.channelId, named.size <= NAMED_ROWS_MAX ? named : null);
  }

  merge(change: ArchiveChange): void {
    for (const [id, kinds] of Object.entries(change.changes)) {
      const named = change.messageIds?.[id];
      this.add(named ? changedMessages(id, named) : wholeChannel(id), kinds, { insertOnly: change.insertOnlyChannelIds.includes(id), nameGuildIds: change.nameGuildIds });
    }
    change.pluginIds?.forEach((id) => this.plugins.add(id));
    if (change.inserted) this.inserted = {
      afterSeq: Math.min(this.inserted?.afterSeq ?? change.inserted.afterSeq, change.inserted.afterSeq),
      throughSeq: Math.max(this.inserted?.throughSeq ?? change.inserted.throughSeq, change.inserted.throughSeq),
    };
  }

  take(): ArchiveChange {
    const changes = Object.fromEntries([...this.channels].map(([id, kinds]) => [id, [...kinds]]));
    const named = [...this.rows].flatMap(([id, ids]): [string, string[]][] => (ids ? [[id, [...ids]]] : []));
    const result: ArchiveChange = {
      changes,
      insertOnlyChannelIds: [...this.channels.keys()].filter((id) => id !== '' && !this.refresh.has(id)),
      ...(this.inserted ? { inserted: this.inserted } : {}),
      ...(this.plugins.size ? { pluginIds: [...this.plugins] } : {}),
      ...(this.names?.size ? { nameGuildIds: [...this.names] } : {}),
      ...(named.length ? { messageIds: Object.fromEntries(named) } : {}),
    };
    this.channels.clear();
    this.refresh.clear();
    this.plugins.clear();
    this.rows.clear();
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
