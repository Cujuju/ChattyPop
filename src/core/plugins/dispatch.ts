// Dispatch to active plugins: hooks, calls and commands, with failure reporting.
import { PluginCallRegistry } from './callRegistry';
import { servedCall } from './callStalls';
import { checkCallRequest, type PluginCallRequest } from '@shared/readPriority';
import { PluginInactiveError } from '@shared/pluginCall';
import { errorMessage } from '@shared/errors';
import { switchState, type PluginState } from '@shared/ruleAvailability';
import type { PluginInfo, PluginMessage, PluginRange } from '@shared/plugins';
import type { Arrived, TextMessage } from '../arrival';
import type { HostDeps } from './api';
import { audiencesOf, completionOf, readsOf, syncReadsOf, type Audience } from '@shared/pluginChannels';
import type { TextSource } from './bundled';
import type { CompletionLedger } from './completions';
import { insideFolder } from './folderPlugins';
import type { Loaded } from './loaded';

/** Runs active plugins' hooks, calls and commands. A throw is recorded on its plugin and shown in Settings; calls and commands also pass it to the caller. */
export abstract class PluginDispatch {
  private readonly calls = new PluginCallRegistry();
  protected readonly plugins = new Map<string, Loaded>();
  /** The signed-in Discord user, once main reports it; handed to bundled plugins that load later. */
  protected self: string | null = null;

  constructor(protected readonly deps: HostDeps) {}

  /** Bundled plugin `id`'s completion reports. */
  protected abstract ledger(id: string): CompletionLedger;

  /** Plugin `id` as unavailability reasons read it; off while not loaded. */
  state(id: string): PluginState {
    const p = this.plugins.get(id);
    return p?.status === 'error' ? { status: 'error', error: p.error } : switchState(p?.status === 'active');
  }

  list(): PluginInfo[] {
    return [...this.plugins.entries()].map(([key, p]) => ({
      key,
      conflict: key !== p.manifest.id,
      id: p.manifest.id,
      name: p.manifest.name ?? p.manifest.id,
      version: p.manifest.version,
      description: p.manifest.description ?? null,
      dir: p.dir,
      bundled: p.origin !== 'folder',
      origin: p.origin,
      status: p.status,
      error: p.error,
      commands: [...p.reg.commands.values()].map((c) => ({ id: c.id, title: c.title })),
      renderer: p.status === 'active' && p.manifest.renderer && insideFolder(p.dir, p.manifest.renderer) ? p.manifest.renderer : null,
    }));
  }

  /** Ingest defers onMessage handlers. Bundled onText handlers only record work synchronously; plugin errors are recorded without interrupting archiving. */
  dispatchMessage(m: TextMessage, arrived: Arrived, source: TextSource): void {
    const message: PluginMessage = { id: m.id, channelId: m.channelId, authorId: m.authorId, ts: m.ts, content: m.content };
    for (const p of this.active()) {
      // Deferred: a plugin turned off before it runs never hears the message.
      const { reg } = p;
      for (const handler of reg.onMessage) setImmediate(() => void (!reg.unloaded && this.guard(p, () => handler(message))));
      for (const handler of p.reg.onText) this.guard(p, () => handler(m, arrived, source));
    }
  }

  /** Main reported the signed-in user. */
  setSelf(userId: string): void {
    this.self = userId;
    for (const p of this.active()) for (const fn of p.reg.onSelf) this.guard(p, () => fn(userId));
  }

  /** Some plugin's derived text for `messageId` settled (derivedText.settle). */
  textSettled(messageId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onTextSettled) this.guard(p, () => fn(messageId));
  }

  /** Any active plugin's derived text for `messageId` is still coming. A throw counts as not pending. */
  textPending(messageId: string): boolean {
    return this.active().some((p) => p.reg.textPending.some((fn) => this.ask(p, () => fn(messageId), false)));
  }

  /** An attachment reached the store. */
  attachmentStored(attachmentId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onAttachmentStored) this.guard(p, () => fn(attachmentId));
  }

  /** A message was stored or updated, or its links gained images: the images it shows may be new (archive.images). */
  imagesShown(messageId: string): void {
    for (const p of this.active()) for (const fn of p.reg.onShown) this.guard(p, () => fn(messageId));
  }

  /** Debounced archive changes, with the same payload windows receive. */
  archiveChanged(change: import('@shared/contract').ArchiveChange): void {
    for (const p of this.active()) for (const fn of p.reg.onArchiveChanged) this.guard(p, () => fn(change));
  }

  /** Privacy mode or its hidden scope changed. */
  privacyChanged(): void {
    for (const p of this.active()) for (const fn of p.reg.onPrivacyChanged) this.guard(p, fn);
  }

  /** The link index was rebuilt from stored messages; runs inside the rebuild's transaction. */
  linksRebuilt(): void {
    for (const p of this.active()) for (const fn of p.reg.onLinksRebuilt) this.guard(p, fn);
  }

  /** Setting `key` was saved. */
  settingChanged(key: string): void {
    for (const p of this.active()) for (const h of p.reg.onSettingChanged) if (h.key === key) this.guard(p, h.fn);
  }

  private active(): Loaded[] {
    return [...this.plugins.values()].filter((p) => p.status === 'active');
  }

  /** Dispatches transport-stamped core calls to declared bundled audiences or folder panels. Records folder errors; bundled errors remain caller-visible only. */
  async call(origin: Audience, pluginId: string, name: string, args: unknown[], request?: PluginCallRequest): Promise<unknown> {
    const p = this.plugins.get(pluginId);
    const reaches = p?.entry ? audiencesOf(p.entry.plugin.channels, 'core', name).includes(origin) : p?.origin === 'folder' && origin === 'renderer';
    // Main's report of work the plugin started: its latest handler takes it, on or off.
    const ledger = reaches && p?.entry && completionOf(p.entry.plugin.channels, name) ? this.ledger(pluginId) : null;
    if (ledger?.handles(name)) return ledger.report(name, args);
    const fn = reaches && p?.status === 'active' ? p.reg.calls.get(name) : undefined;
    if (p && reaches && p.status !== 'active') throw new PluginInactiveError(pluginId);
    if (!p || !fn) throw new Error(`Plugin ${pluginId} has no function ${name} for ${origin}`);
    try {
      const call = this.calls.start(origin, pluginId, checkCallRequest(request));
      try {
        call.signal.throwIfAborted();
        return await servedCall({ plugin: pluginId, member: name, reads: readsOf(p.entry?.plugin.channels, name), syncReads: syncReadsOf(p.entry?.plugin.channels, name),
          signal: call.signal, priority: request?.priority ?? 'background', strict: this.deps.strictSyncReads ?? !!process.env.VITEST,
          diag: this.deps.diag ?? (() => undefined) }, () => fn(...args));
      } finally { call.end(); }
    } catch (err) {
      if (p.origin === 'folder') this.fail(p, err);
      throw err;
    }
  }

  cancelCall(origin: Audience, pluginId: string, id: string): void { this.calls.cancel(origin, pluginId, id); }

  async runCommand(pluginId: string, commandId: string, range: PluginRange): Promise<string | null> {
    const p = this.plugins.get(pluginId);
    const command = p?.status === 'active' ? p.reg.commands.get(commandId) : undefined;
    if (!p || !command) throw new Error(`No command ${commandId} in plugin ${pluginId}`);
    try {
      return (await command.run(range)) ?? null;
    } catch (err) {
      this.fail(p, err);
      throw err;
    }
  }

  /** Runs a plugin's synchronous query; a throw is recorded on the plugin and answers `fallback`. */
  private ask<T>(p: Loaded, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.fail(p, err);
      return fallback;
    }
  }

  /** Runs plugin code; a throw or rejection is recorded on the plugin and shown in Settings. */
  protected guard(p: Loaded, fn: () => unknown): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((err: unknown) => this.fail(p, err));
    } catch (err) {
      this.fail(p, err);
    }
  }

  private fail(p: Loaded, err: unknown): void {
    console.error(`[plugin ${p.manifest.id}]`, err);
    const changed = p.error !== errorMessage(err);
    p.error = errorMessage(err);
    if (changed) this.deps.emit({ type: 'plugins-changed' });
  }
}
