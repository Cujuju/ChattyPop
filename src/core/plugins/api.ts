// Folder-plugin API and registrations shared with the bundled plugin host.
import { pluginSettingKey, pluginTableName } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { PLUGIN_API_VERSION, type PluginApi, type PluginCommand, type PluginMessage, type PluginStatement } from '@shared/plugins';
import { MS_PER_MIN } from '@shared/units';
import { PluginInactiveError } from '@shared/pluginCall';
import { localOnlyChannelIds } from '../channelPolicy';
import type { DecisionProvider, Question, Structured } from '../ai/decisions';
import { TURNED_OFF } from '../ai/types';
import { assertJevMayRead, scopedDecider, type ScopedCompletion } from '../ai/readScope';
import type { Arrived, TextMessage } from '../arrival';
import { getSetting, setSetting, type Db } from '../db';
import type { BundledDeps, TextSource } from './bundled';
import type { CompletionHandler } from './completions';
import { pluginDb } from './pluginDb';

/** Shortest schedule interval: a plugin loop can't keep the core busy. */
export const MIN_SCHEDULE_MS = MS_PER_MIN;
/** query.messages page size when the plugin gives none, and the most it may ask for at once. */
const DEFAULT_QUERY_LIMIT = 1000;
const MAX_QUERY_LIMIT = 10_000;

/** Host services shared by folder and bundled plugins. */
export interface HostDeps {
  db: Db;
  emit(e: AppEvent): void;
  /** The Archive re-reads this channel (annotations changed). */
  changed(channelId: string): void;
  /** A completion from the default provider, refused (LocalOnlyError) when it may not read `reads`; `signal` cancels it. */
  ai: ScopedCompletion;
  /** Jev for plugins (Settings → Jev), or null when off. */
  decider(): DecisionProvider | null;
  /** What bundled plugins' contexts are built from; absent where no bundled plugin loads (tests of folder plugins). */
  bundled?: BundledDeps;
}

/** Activation registrations, all dropped on unload (completion report handlers live in the host's ledger). */
export interface Registrations {
  onMessage: ((m: PluginMessage) => void | Promise<void>)[];
  commands: Map<string, PluginCommand>;
  timers: NodeJS.Timeout[];
  /** Its core calls: a folder plugin's rpc.handle (its panels), a bundled plugin's channels.serve (its audiences). */
  calls: Map<string, (...args: unknown[]) => unknown>;
  /** Set when the plugin unloads: what it still holds of its context (a job finishing) then does nothing. */
  unloaded: boolean;
  /** Bundled plugins only (CoreContext). */
  disposers: (() => void)[];
  onText: ((m: TextMessage, arrived: Arrived, source: TextSource) => void)[];
  onSelf: ((userId: string) => void)[];
  textPending: ((messageId: string) => boolean)[];
  onTextSettled: ((messageId: string) => void)[];
  onAttachmentStored: ((attachmentId: string) => void)[];
  onShown: ((messageId: string) => void)[];
  onSettingChanged: { key: string; fn: () => void }[];
  onArchiveChanged: ((channelIds: string[]) => void)[];
  onLinksRebuilt: (() => void)[];
  /** It provides attachment notes, dropped on unload. */
  attachmentNotes: boolean;
  /** Subjects of the per-message Jev questions it registered, dropped on unload. */
  jevQuestions: string[];
  /** Keys (registrationCheck) of what a bundled activation registered, checked against its descriptor once it returns. */
  registered: Set<string>;
  /** Completion handlers the activation set; its ledger adopts them once it passes that check. Null after: handle throws. */
  handlers: Map<string, CompletionHandler> | null;
}

/** Fresh registrations for one plugin activation. */
export const emptyRegistrations = (): Registrations => ({
  onMessage: [],
  commands: new Map(),
  timers: [],
  calls: new Map(),
  unloaded: false,
  disposers: [],
  onText: [],
  onSelf: [],
  textPending: [],
  onTextSettled: [],
  onAttachmentStored: [],
  onShown: [],
  onSettingChanged: [],
  onArchiveChanged: [],
  onLinksRebuilt: [],
  attachmentNotes: false,
  jevQuestions: [],
  registered: new Set(),
  handlers: new Map(),
});

/** Whether an activation's services act: until it unloads, for good (a completion report finalizes through its own grant). */
export const servicesLive = (reg: Registrations): boolean => !reg.unloaded;

/** Runs a plugin's schema steps not yet applied, each with its version bump in one transaction. */
export function migratePlugin(db: Db, pluginId: string, steps: readonly string[]): void {
  const key = pluginSettingKey(pluginId, '$schemaVersion');
  const applied = Number(getSetting(db, key)) || 0;
  for (let v = applied; v < steps.length; v++) {
    db.transaction(() => {
      db.exec(steps[v]!);
      setSetting(db, key, v + 1);
    })();
  }
}

/** Builds activation-scoped APIs and guards callbacks. After unload, registrations/settings/notices/annotations are inert; AI and database writes throw PluginInactiveError. */
export function createPluginApi(id: string, deps: HostDeps, reg: Registrations, guard: (fn: () => unknown) => void): PluginApi {
  const { db } = deps;
  const settingKey = (key: string): string => pluginSettingKey(id, key);
  const live = (): boolean => servicesLive(reg);
  // Statements that write, even ones prepared earlier, throw once it unloads; reads stay open (the bundled rule too).
  const fenced = pluginDb(() => db, live, id);
  const inactive = (): Promise<never> => Promise.reject(new PluginInactiveError(id));
  return {
    apiVersion: PLUGIN_API_VERSION,
    pluginId: id,
    onMessage: (handler) => void (live() && reg.onMessage.push(handler)),
    schedule: (everyMs, fn) => void (live() && reg.timers.push(setInterval(() => guard(fn), Math.max(MIN_SCHEDULE_MS, everyMs)))),
    commands: { register: (c) => void (live() && reg.commands.set(c.id, c)) },
    query: {
      messages: (q) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (q.channelIds?.length) {
          where.push(`m.channel_id IN (${q.channelIds.map(() => '?').join(',')})`);
          params.push(...q.channelIds);
        }
        if (q.sinceTs !== undefined) {
          where.push('m.ts >= ?');
          params.push(q.sinceTs);
        }
        if (q.untilTs !== undefined) {
          where.push('m.ts <= ?');
          params.push(q.untilTs);
        }
        const limit = Math.min(MAX_QUERY_LIMIT, q.limit ?? DEFAULT_QUERY_LIMIT);
        return db
          .prepare(
            `SELECT m.id, m.channel_id AS channelId, m.author_id AS authorId, m.ts, m.text AS content FROM archive_messages m
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.ts LIMIT ?`,
          )
          .all(...params, limit) as PluginMessage[];
      },
      channels: () => {
        const localOnly = localOnlyChannelIds(db); // once per call, not per row
        const rows = db
          .prepare(
            // Positions aren't in the view; the host table orders the rows the view lets through.
            `SELECT c.id, c.name, COALESCE(g.name, '') AS guildName FROM archive_channels c JOIN channels r ON r.id = c.id
             LEFT JOIN archive_guilds g ON g.id = c.guild_id WHERE c.opted_in = 1 ORDER BY g.name, r.position, c.name`,
          )
          .all() as { id: string; name: string; guildName: string }[];
        return rows.map((c) => ({ ...c, localAiOnly: localOnly.has(c.id) }));
      },
    },
    db: {
      table: (name) => pluginTableName(id, name),
      migrate: (steps) => {
        if (!live()) throw new PluginInactiveError(id);
        migratePlugin(db, id, steps);
      },
      prepare: (sql): PluginStatement => fenced.prepare(sql),
      transaction: (fn) => db.transaction(fn)(),
    },
    settings: { get: (key) => getSetting(db, settingKey(key)), set: (key, value) => void (live() && setSetting(db, settingKey(key), value)) },
    ai: {
      complete: (req) => (live() ? deps.ai(req) : inactive()),
      providers: () => {
        const bundled = deps.bundled;
        if (!bundled) return []; // no bundled plugin loads, so none registers a provider
        const ai = bundled.aiSettings();
        return bundled.providers.providers().map((p) => ({
          id: p.id,
          label: p.label,
          local: p.local ?? false,
          unavailable: p.unavailable ?? (ai.providers[p.id]?.enabled ? null : TURNED_OFF),
        }));
      },
      decide: async (req) => {
        if (!live()) return inactive();
        assertJevMayRead(db, req.reads);
        const jev = deps.decider();
        if (!jev) throw new Error('Turn on Settings → Jev → Let plugins ask Jev (and set a Jev key) to use ai.decide().');
        return scopedDecider(jev, () => db).decide({ state: req.state as Structured, questions: req.questions as Record<string, Question>, reads: req.reads });
      },
    },
    notify: (n) => void (live() && deps.emit({ type: 'plugin-notify', pluginId: id, ...n })),
    annotate: (messageId, label, text) => {
      if (!live()) return;
      if (text === null) db.prepare('DELETE FROM plugin_annotations WHERE plugin_id = ? AND message_id = ? AND label = ?').run(id, messageId, label);
      else
        db.prepare(
          `INSERT INTO plugin_annotations (plugin_id, message_id, label, text, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(plugin_id, message_id, label) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
        ).run(id, messageId, label, text, Date.now());
      const row = db.prepare('SELECT channel_id AS c FROM messages WHERE id = ?').get(messageId) as { c: string } | undefined;
      if (row) deps.changed(row.c);
    },
    log: (...args) => console.log(`[plugin ${id}]`, ...args),
    rpc: { handle: (name, fn) => void (live() && reg.calls.set(name, fn)) },
  };
}
