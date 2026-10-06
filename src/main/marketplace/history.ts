// Install history (PluginHistory) kept after a plugin's folder goes, so restore knows its origin and whether removal
// was asked. A staged entry is provisional: cancelling restores the earlier one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginHistory } from '@shared/marketplace';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';
import { REPO_PATTERN } from '@shared/installedPlugins';

/** Profile file of the install history. */
export const PLUGIN_HISTORY_FILE = 'plugin-history.json';

type Entry = PluginHistory[string];

/** The file: each plugin's entry, and, while a change is staged, its entry before that change (null: it had none). */
interface Stored {
  plugins: PluginHistory;
  beforeStaged: Record<string, Entry | null>;
}

/** `v` as an entry; undefined when malformed. */
function entryOf(v: unknown): Entry | undefined {
  const e = v as { repo?: unknown; uninstalled?: unknown } | null;
  const repo = e?.repo === null || (typeof e?.repo === 'string' && REPO_PATTERN.test(e.repo)) ? e.repo : undefined;
  return repo !== undefined && typeof e?.uninstalled === 'boolean' ? { repo, uninstalled: e.uninstalled } : undefined;
}

/** `raw`'s well-formed entries by plugin id; `orNull` keeps null ones (no entry before a staged change). */
function entriesOf<T extends Entry | null>(raw: unknown, orNull: boolean): Record<string, T> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(raw)) {
    const entry = v === null && orNull ? null : entryOf(v);
    if (PLUGIN_ID_PATTERN.test(id) && entry !== undefined) out[id] = entry as T;
  }
  return out;
}

export class InstallHistory {
  constructor(private readonly profileDir: string) {}

  private get file(): string {
    return join(this.profileDir, PLUGIN_HISTORY_FILE);
  }

  /** The stored file; a malformed file or entry reads as absent. */
  private stored(): Stored {
    let raw: { plugins?: unknown; beforeStaged?: unknown } | null;
    try {
      raw = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as typeof raw) : null;
    } catch {
      raw = null; // Unreadable history leaves restore candidates unfiltered.
    }
    return { plugins: entriesOf<Entry>(raw?.plugins, false), beforeStaged: entriesOf<Entry | null>(raw?.beforeStaged, true) };
  }

  read(): PluginHistory {
    return this.stored().plugins;
  }

  /** `id` was staged from `repo` (null: a local build). `fresh`: no other change of it was staged. */
  installed(id: string, repo: string | null, fresh: boolean): void {
    this.stage(id, () => ({ repo, uninstalled: false }), fresh);
  }

  /** `id`'s removal was asked for; `repo` is where its copy came from (source.json), for one installed before the history. */
  uninstalled(id: string, repo: string | null, fresh: boolean): void {
    this.stage(id, (now) => ({ repo: now?.repo ?? repo, uninstalled: true }), fresh);
  }

  /** `id`'s staged changes were cancelled: its entry from before them comes back. */
  cancelled(id: string): void {
    const { plugins, beforeStaged } = this.stored();
    if (!(id in beforeStaged)) return;
    const { [id]: before, ...stillStaged } = beforeStaged;
    const { [id]: _staged, ...others } = plugins;
    this.write({ plugins: before ? { ...others, [id]: before } : others, beforeStaged: stillStaged });
  }

  /**
   * Sets `id`'s entry to `next` of the current one. A fresh change records the entry it replaces; one over a staged
   * change keeps that change's record.
   */
  private stage(id: string, next: (now: Entry | undefined) => Entry, fresh: boolean): void {
    const { plugins, beforeStaged } = this.stored();
    const before = !fresh && id in beforeStaged ? (beforeStaged[id] ?? null) : (plugins[id] ?? null);
    this.write({ plugins: { ...plugins, [id]: next(plugins[id]) }, beforeStaged: { ...beforeStaged, [id]: before } });
  }

  private write(stored: Stored): void {
    writeFileSync(this.file, JSON.stringify(stored, null, 2));
  }
}
