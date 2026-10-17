// Host-aggregated archive tools: scoped inputs, validated output and activation fencing.
import { isObj } from '@shared/normalize';
import { PluginInactiveError } from '@shared/pluginCall';
import type { Db } from '../db';
import { privacy } from '../queries/privacy';
import { joined, untilRevoked } from './revocable';

export interface ArchiveToolScope {
  /** Privacy-visible channels permitted for the caller's provider. Read nothing else. */
  readonly channelIds: readonly string[];
  /** Inclusive millisecond bounds; null means unbounded. */
  readonly since: number | null;
  readonly until: number | null;
}

export interface ArchiveToolLine {
  text: string;
  /** The in-scope message this line quotes or describes. */
  messageId?: string;
}

export interface ArchiveToolResult {
  lines: readonly ArchiveToolLine[];
  /** Every channel shaping any line or note, including cited lines' channels. Required and non-empty whenever lines is non-empty. */
  readChannels?: readonly string[];
  note?: string;
  /** More matching results exist; the host appends its fixed truncation notice. */
  more?: boolean;
}

export interface ArchiveTool {
  /** A declared local aiTools name. */
  name: string;
  description: string;
  /** Object schema with primitive or primitive-array properties; see the documented archive-tool subset. */
  parameters: Record<string, unknown>;
  run(args: unknown, scope: ArchiveToolScope, signal: AbortSignal): Promise<ArchiveToolResult>;
}

export interface ArchiveToolInfo { name: string; plugin: string; pluginName: string; description: string; parameters: Record<string, unknown> }

/** Keeps tool answers small enough for a model to read alongside other lookups. */
export const ARCHIVE_TOOL_LINES_MAX = 50;
const UNAVAILABLE_NOTE = "This lookup's results are unavailable.";
const MORE_NOTE = 'More results not shown.';

interface Entry {
  order: number;
  info: ArchiveToolInfo;
  run: ArchiveTool['run'] | null;
}

// Separate profiles and test hosts never share registrations. Retired entries retain names, not plugin callbacks.
const registries = new WeakMap<Db, Map<string, Entry>>();
const registry = (db: Db): Map<string, Entry> => {
  let entries = registries.get(db);
  if (!entries) { entries = new Map(); registries.set(db, entries); }
  return entries;
};

/** Intersects channel scope with current privacy and freezes it against mutation by a tool. */
function visibleScope(db: Db, scope: ArchiveToolScope): ArchiveToolScope {
  const { since, until } = scope;
  if ((since !== null && !Number.isFinite(since)) || (until !== null && !Number.isFinite(until)) || (since !== null && until !== null && since > until)) {
    throw new RangeError('Archive tool window must have finite bounds with since <= until.');
  }
  const channelIds = db.prepare('SELECT id FROM archive_channels WHERE id IN (SELECT value FROM json_each(?))')
    .pluck().all(JSON.stringify(scope.channelIds)) as string[];
  return Object.freeze({ channelIds: Object.freeze(channelIds), since, until });
}

/** Validates lines against current archive visibility, redacts text, and records discarded lines once. */
function guardedResult(db: Db, pluginId: string, result: unknown, scope: ArchiveToolScope): ArchiveToolResult {
  if (!isObj(result) || !Array.isArray(result['lines'])) throw new TypeError('An archive tool must return lines.');
  const allowed = new Set(scope.channelIds);
  const declared = result['readChannels'];
  const provenanceValid = Array.isArray(declared) && declared.length > 0
    && [...declared].every((id) => typeof id === 'string' && allowed.has(id));
  if (result['lines'].length && !provenanceValid) {
    console.warn(`[plugin ${pluginId}] archive-tool-dropped-lines`, result['lines'].length);
    return { lines: [], note: UNAVAILABLE_NOTE };
  }
  const readChannels = provenanceValid ? [...new Set(declared as string[])] : [];
  const provenance = new Set(readChannels);
  const message = db.prepare('SELECT channel_id AS channelId, ts FROM archive_messages WHERE id = ?');
  const { redact } = privacy(db);
  const lines: ArchiveToolLine[] = [];
  let capped = false;
  for (const line of result['lines'] as unknown[]) {
    if (!isObj(line) || typeof line['text'] !== 'string') continue;
    const id = line['messageId'];
    if (id !== undefined) {
      if (typeof id !== 'string') continue;
      const row = message.get(id) as { channelId: string; ts: number } | undefined;
      if (!row || !allowed.has(row.channelId) || !provenance.has(row.channelId)
        || (scope.since !== null && row.ts < scope.since) || (scope.until !== null && row.ts > scope.until)) continue;
    }
    if (lines.length >= ARCHIVE_TOOL_LINES_MAX) { capped = true; continue; }
    lines.push({ text: redact(line['text']), ...(id !== undefined ? { messageId: id as string } : {}) });
  }
  const dropped = result['lines'].length - lines.length;
  if (dropped) console.warn(`[plugin ${pluginId}] archive-tool-dropped-lines`, dropped);
  const note = provenanceValid && typeof result['note'] === 'string' ? redact(result['note']) : '';
  const more = result['more'] === true || capped;
  return {
    lines,
    ...(Array.isArray(declared) ? { readChannels } : {}),
    ...(more ? { more: true } : {}),
    ...(note || more ? { note: [note, more ? MORE_NOTE : ''].filter(Boolean).join('\n') } : {}),
  };
}

/** Registers one validated declaration; disposing retires the name and drops all activation-owned callbacks. */
export function registerArchiveTool(db: Db, order: number, info: ArchiveToolInfo, tool: ArchiveTool, lifetime: AbortSignal, fail: (err: unknown) => void): () => void {
  const entries = registry(db);
  const run = tool.run.bind(tool);
  const entry: Entry = {
    order,
    info: structuredClone(info),
    run: (args, scope, signal) => {
      const active = joined(lifetime, signal);
      return untilRevoked(active, async () => {
        const scoped = visibleScope(db, scope);
        try {
          const result = await run(structuredClone(args), scoped, active);
          active.throwIfAborted();
          return guardedResult(db, info.plugin, result, visibleScope(db, scoped));
        } catch (err) {
          if (!active.aborted) fail(err);
          throw err;
        }
      });
    },
  };
  entries.set(info.name, entry);
  return () => { entry.run = null; };
}

/** Active tools in build order, with independent metadata copies and the caller's tools excluded. */
export function listArchiveTools(db: Db, caller: string): readonly ArchiveToolInfo[] {
  return [...registry(db).values()].filter((e) => e.run && e.info.plugin !== caller).sort((a, b) => a.order - b.order).map((e) => structuredClone(e.info));
}

/** Runs a contributed tool; retired known names reject with their plugin's inactive error. */
export function runArchiveTool(db: Db, caller: string, name: string, args: unknown, scope: ArchiveToolScope, signal: AbortSignal): Promise<ArchiveToolResult> {
  const entry = registry(db).get(name);
  if (!entry || entry.info.plugin === caller) return Promise.reject(new Error(`Unknown archive tool: ${name}.`));
  if (!entry.run) return Promise.reject(new PluginInactiveError(entry.info.plugin));
  return entry.run(args, scope, signal);
}
