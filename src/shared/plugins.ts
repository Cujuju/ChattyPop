// Plugin contract (docs/plugins.md). Plugins are full trust: ESM loaded into the core process, no sandbox.
// The API version is the compatibility promise: a plugin loads when its apiVersion's major equals the host's.

/**
 * 1.1: renderer entry (panels) and rpc.handle. 1.2: ai.decide (Jev). 2.0: AI requests declare `reads`; query.* return
 * only what privacy mode shows. 3.0: ai.complete names its provider (no default provider); ai.providers lists them. A
 * plugin written for another major doesn't load.
 */
export const PLUGIN_API_VERSION = '3.0.0';
/** What this major changed from the one before, for the load error of a plugin written for an older major. */
export const PLUGIN_API_MAJOR_CHANGES = 'ai.complete names the provider it asks (provider; ai.providers lists them): there is no default provider';
/** Protocol serving a plugin's renderer files: chattypop-plugin://<plugin id>/<path in its folder>. */
export const PLUGIN_SCHEME = 'chattypop-plugin';
/** Lowercase letters, digits and dashes: the id names the plugin's tables and settings. */
export const PLUGIN_ID_SOURCE = '[a-z][a-z0-9-]{1,39}';
export const PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_SOURCE}$`);
/** Layout ids of plugin panels: plugin:<plugin id>:<panel id>. */
export type PluginPanelId = `plugin:${string}:${string}`;
const PLUGIN_PANEL_ID_PATTERN = new RegExp(`^plugin:${PLUGIN_ID_SOURCE}:[\\w-]+$`);
export const pluginPanelId = (pluginId: string, panelId: string): PluginPanelId => `plugin:${pluginId}:${panelId}`;
export const isPluginPanelId = (id: string): id is PluginPanelId => PLUGIN_PANEL_ID_PATTERN.test(id);
/** The plugin a plugin panel's layout id belongs to. */
export const pluginOfPanelId = (id: PluginPanelId): string => id.split(':')[1]!;
/** plugin.json in each folder under the plugins directory. */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

export interface PluginManifest {
  id: string;
  name?: string;
  version: string;
  /** Semver of the plugin API it was written against. */
  apiVersion: string;
  /** Core entry, relative to the plugin folder: an ES module exporting `activate(api)`. */
  main: string;
  /** Optional renderer entry (API 1.1): an ES module exporting `panels` (see PluginPanel). */
  renderer?: string;
  description?: string;
}

/** A Jev question (see src/core/ai/decisions.ts): noul = yes/no, choice = one of criteria's keys, score = a level of criteria. */
export type PluginQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

/**
 * The channels whose text an AI request carries: their ids (a thread by its own), or 'all'. A hosted model is refused
 * a channel set to local AI only (or a thread under one), and 'all' while any channel is.
 */
export type ReadScope = readonly string[] | 'all';

export interface PluginDecideRequest {
  /** What the questions are about (text or JSON); refer to its fields by name in the instructions. */
  state: unknown;
  questions: Record<string, PluginQuestion>;
  /** API 2.0: the channels `state` was taken from. Jev is hosted. */
  reads: ReadScope;
}

/** Per question id: { type: 'noul', noul } | { type: 'choice', choice, probabilities } | { type: 'score', score, probabilities }; missing = no answer. */
export interface PluginDecideResult {
  answers: Record<string, unknown>;
  costUsd: number | null;
}

export interface PluginMessage {
  id: string;
  channelId: string;
  authorId: string;
  ts: number;
  /** The text, then the transcript of any voice message (which may arrive later, as an edit would). */
  content: string;
}

export interface PluginRange {
  sinceTs: number;
  untilTs: number;
  /** null = every archived channel. */
  channelIds: string[] | null;
}

export interface PluginCommand {
  id: string;
  title: string;
  /** The returned text is shown to the user. */
  run(range: PluginRange): Promise<string | void> | string | void;
}

/** Minimal statement surface (better-sqlite3's, which it is). */
export interface PluginStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface PluginApi {
  readonly apiVersion: string;
  readonly pluginId: string;
  /** Every new or edited message text in archived channels: live, catch-up and backfill alike. */
  onMessage(handler: (m: PluginMessage) => void | Promise<void>): void;
  /** Runs `fn` every `everyMs` (at least a minute) while the app is open. */
  schedule(everyMs: number, fn: () => void | Promise<void>): void;
  commands: { register(command: PluginCommand): void };
  query: {
    /** Archived messages oldest first, as privacy mode shows them (API 2.0). */
    messages(q: { channelIds?: string[]; sinceTs?: number; untilTs?: number; limit?: number }): PluginMessage[];
    /**
     * Archived channels as privacy mode shows them (API 2.0). localAiOnly: the owner allows this channel's text only on a
     * local model; hosted AI refuses requests that read it.
     */
    channels(): { id: string; name: string; guildName: string; localAiOnly: boolean }[];
  };
  db: {
    /** Namespaced table name: p_<plugin id>_<name>. Use it in every table the plugin creates. */
    table(name: string): string;
    /** Applies the steps not yet applied (by index), each in a transaction. Append steps; never edit shipped ones. */
    migrate(steps: string[]): void;
    prepare(sql: string): PluginStatement;
    transaction<T>(fn: () => T): T;
  };
  settings: { get(key: string): unknown; set(key: string, value: unknown): void };
  ai: {
    /**
     * Asks AI provider `provider` (an id from providers()) with its Settings → AI model and effort; rejects while it can't
     * run or is turned off. `reads` names the channels the prompt was taken from.
     */
    complete(req: { provider: string; system: string; prompt: string; schema?: Record<string, unknown>; reads: ReadScope }): Promise<{ text: string; json?: unknown }>;
    /** API 3.0: every AI provider, with why it can't be asked now (null while it can). */
    providers(): { id: string; label: string; local: boolean; unavailable: string | null }[];
    /**
     * API 1.2: typed judgments from Jev (the decision model): yes/no probabilities, one-of choices and scores, never
     * generated text. Throws when Settings → Jev → plugins is off or no Jev key is set.
     */
    decide(req: PluginDecideRequest): Promise<PluginDecideResult>;
  };
  /** A Windows notification; clicking it opens the message when one is given. */
  notify(n: { title: string; body: string; channelId?: string; messageId?: string }): void;
  /** A labelled note shown under the message in the Archive. Same label again replaces it; null text removes it. */
  annotate(messageId: string, label: string, text: string | null): void;
  log(...args: unknown[]): void;
  /** API 1.1: a function the plugin's panels can call (PanelApi.call). Arguments and results must be JSON-safe. */
  rpc: { handle(name: string, fn: (...args: unknown[]) => unknown): void };
}

export type PluginStatus = 'active' | 'disabled' | 'error';
/** Where a plugin comes from: compiled into this build, installed into the profile (§16), or the plugins folder (PluginApi). */
export type PluginOrigin = 'bundled' | 'installed' | 'folder';

export interface PluginInfo {
  /** Unique settings-row identity; distinct from a conflicting manifest id. */
  key?: string;
  conflict?: boolean;
  id: string;
  name: string;
  version: string;
  description: string | null;
  /** The plugin folder; '' for a bundled plugin. */
  dir: string;
  /** A descriptor plugin (bundled or installed), not a plugins-folder one. */
  bundled: boolean;
  origin: PluginOrigin;
  status: PluginStatus;
  /** Load failure, or the latest error a hook threw. */
  error: string | null;
  commands: { id: string; title: string }[];
  /** Renderer entry path inside the plugin folder, when it has panels and is active. */
  renderer: string | null;
}

/** Whether core's list has descriptor plugin `id` on. */
export const pluginOn = (list: readonly PluginInfo[], id: string): boolean => list.some((p) => p.id === id && p.bundled && p.status === 'active');

export interface MessageAnnotation {
  pluginId: string;
  label: string;
  text: string;
}
