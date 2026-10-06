// Runs core plugins through real host adapters with scripted AI, network stand-ins and injected clocks.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerDeclarations, providerPlugin, type DeclaredProvider } from '@shared/aiProviders';
import { pluginJevFeature, pluginSettingKey, stampedName, type PluginDescriptor } from '@shared/bundledTypes';
import type { AppEvent } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import { clientOver } from '@shared/pluginChannels';
import type { PluginCallResult } from '@shared/pluginCall';
import { jevFeatureOn, normalizeAiSettings, normalizeArchiveSettings, SETTINGS_KEYS, type AiSettings, type JevFeature } from '@shared/settings';
import { decodeWire, encodeWire } from '@shared/wire';
import { preferenceOf, readPreference } from '@shared/preferences';
import { scopedCompletion } from '@core/ai/readScope';
import { ProviderRegistry } from '@core/ai/registry';
import { Archive } from '@core/archive';
import { archiveHandlers } from '@core/archiveHandlers';
import { getSetting, openDb, setSetting, type Db } from '@core/db';
import { allMuted } from '@core/queries/notificationMute';
import { storeDerivedText, storeLinkText } from '@core/derivedText';
import { storeLinkImages } from '@core/messageImages';
import { adoptBundledData } from '@core/plugins/adoption';
import type { BundledDeps } from '@core/plugins/bundled';
import type { CorePlugin } from '@core/plugins/context';
import { PLUGINS_DISABLED_KEY, PluginHost } from '@core/plugins/host';
import { pluginDb } from '@core/plugins/pluginDb';
import { previousSeenAt, recordSeen } from '@core/lastSeen';
import { addedTextArrival, textMessage } from '@core/queries/messageText';
import { RuleKinds } from '@core/rules/kinds';
import { ruleKindLookup } from '@shared/ruleKinds';
import { pluginHandlers } from '@core/serviceHandlers';
import { PhoneHub, type PhoneGateway } from '@main/phone/hub';
import { ARRIVAL } from '@core/arrival';
import { channelPolicy, rawMessage, seedArchive } from './archive';
import { coreLink, unlinkCore, type CorePort } from '../../shared/testing/ports';
import type { TestOptions, TestPlugin, TestPluginFn } from './types';

/** The status every scripted provider reports: it runs, with no model list. */
const SCRIPTED_STATUS = { available: true, detail: '', models: [] };
/** The Discord calls and media the harness's phone gateway has none of. */
const NO_PHONE_EXTRAS = (): never => {
  throw new Error('The core test harness has no Discord session or media store.');
};

/** Declares scripted test providers. */
const scriptedDeclaration = (id: string, local: boolean, images: boolean): DeclaredProvider => ({
  id,
  label: id,
  displayName: id,
  enabledByDefault: true,
  local,
  images,
  plugin: { id: providerPlugin(id), name: id },
});

/** Settings → AI as `ai` sets them: the scripted providers on, and the switches stamped. */
function aiSeed<D extends PluginDescriptor>(plugin: D, ai: NonNullable<TestOptions<D>['ai']>, scripted: readonly string[]): unknown {
  const jev = Object.fromEntries(Object.entries(ai.switches ?? {}).map(([key, on]) => [pluginJevFeature(plugin, key), on]));
  return { providers: Object.fromEntries(scripted.map((p) => [p, { enabled: true }])), jev };
}

export const testPlugin: TestPluginFn = (definition, options = {}) => start(definition, options, mkdtempSync(join(tmpdir(), 'chattypop-plugin-test-')), true);

function start<D extends PluginDescriptor>(definition: CorePlugin<D> | D, o: TestOptions<D>, dir: string, fresh: boolean): TestPlugin<D> {
  const entries = [definition, ...(o.with ?? [])];
  const cores = entries.filter((e): e is CorePlugin => 'activate' in e);
  const installed = entries.map((e) => ('activate' in e ? e.plugin : e));
  const plugin = installed[0] as D;
  const id = plugin.manifest.id;
  const now = o.clock ?? Date.now;
  const db = openDb(join(dir, 'archive.db'));
  const events: AppEvent[] = [];
  const listeners = new Set<(e: AppEvent) => void>();
  // Clones emitted events per process; subsequent mutations do not propagate.
  const emit = (e: AppEvent): void => {
    events.push(structuredClone(e));
    listeners.forEach((fn) => fn(structuredClone(e)));
  };
  const scripted = o.ai?.providers ?? [];
  const decls = [...providerDeclarations(installed), ...scripted.map((p) => scriptedDeclaration(p.id, p.local ?? false, p.images ?? false))];
  const features = installed.flatMap((p) => (p.jev?.features ?? []).map((f) => ({ key: stampedName(p.manifest.id, f.key), default: f.default })));
  const registry = new ProviderRegistry(() => undefined, decls);
  for (const p of scripted) registry.register(p.id, { create: () => p.provider, status: async () => SCRIPTED_STATUS });
  const ai = (): AiSettings => normalizeAiSettings(getSetting(db, SETTINGS_KEYS.ai), decls, features);
  // Jev for a switch that is on: the registry's check, with the scripted Jev in place of a keyed connection.
  const jevFor = (feature: JevFeature) => (o.ai?.jev && jevFeatureOn(ai().jev, feature) ? o.ai.jev : null);
  let host!: PluginHost;
  const archive = new Archive(db, (m, arrived) => host.dispatchMessage(m, arrived, 'message'), undefined, (id) => host.imagesShown(id));
  const saveSetting = (key: string, value: unknown): void => {
    setSetting(db, key, value);
    emit({ type: 'setting-changed', key, value });
    host.settingChanged(key);
    if (key === SETTINGS_KEYS.privacyMode) emit({ type: 'privacy-changed' });
  };
  /** When the previous session was last seen, read as core starts (startLastSeen). */
  let lastSeen = 0;
  let self: string | null = o.self ?? null;
  const bundled: BundledDeps = {
    rules: new RuleKinds(ruleKindLookup(installed)),
    ready: () => db,
    archive: () => archive,
    mediaDir: join(dir, 'media'),
    attachmentsDir: join(dir, 'media', 'attachments'),
    pluginData: { root: join(dir, 'plugin-data'), unmoved: {} },
    storeText: (pluginId, messageId, t, record) => {
      storeDerivedText(db, messageId, `${pluginId}:${t.key}`, t.order, t.text, record, t.part ?? null);
      const m = textMessage(db, messageId);
      if (m) host.dispatchMessage(m, addedTextArrival(db, messageId, t.queuedAt), 'transcript');
    },
    storeLinkText: (pluginId, url, text, record) => void storeLinkText(db, url, pluginId, text, record),
    storeLinkImages: (pluginId, url, images, record) => storeLinkImages(db, url, pluginId, images, record).forEach((id) => host.imagesShown(id)),
    saveSetting,
    aiSettings: ai,
    providers: registry,
    decider: jevFor,
    catchUp: () => undefined,
    now,
    lastSeenAt: () => lastSeen,
    send: o.network ?? (() => Promise.reject(new Error('This test gives the plugin no network.'))),
  };
  const kinds = bundled.rules;
  host = new PluginHost(join(dir, 'plugins'), { db, emit, changed: () => undefined, ai: scopedCompletion(() => db, registry, ai), decider: () => jevFor('pluginDecide'), bundled }, cores, installed);
  if (fresh) {
    for (const [key, value] of Object.entries(o.profile?.settings ?? {})) setSetting(db, key, value);
    for (const sql of o.profile?.sql ?? []) db.exec(sql);
  }
  adoptBundledData(db, installed);
  lastSeen = previousSeenAt(db, now());
  recordSeen(db, now());
  if (fresh) {
    seedArchive(db, archive, o.archive ?? {}, now);
    for (const [name, value] of Object.entries(o.preferences ?? {})) setSetting(db, pluginSettingKey(id, name), value);
    if (o.ai) setSetting(db, SETTINGS_KEYS.ai, aiSeed(plugin, o.ai, scripted.map((p) => p.id)));
    if (o.off) setSetting(db, PLUGINS_DISABLED_KEY, [id]);
  }
  host.startBundled();
  if (self) host.setSelf(self);

  const archiveService = archiveHandlers({
    ready: () => ({ db, archive }),
    emit,
    noteChanged: (channelId) => {
      if (!channelId) return;
      emit({ type: 'archive-changed', channelIds: [channelId] });
      host.archiveChanged([channelId]);
    },
    backfillFromMs: () => 0,
    selfId: () => self,
    lastSeenAt: () => lastSeen,
    // Harness omits text retention; changing channel tiers does not alter stored text.
    applyTextTier: async () => undefined,
    autoArchiveSinceMs: () => normalizeArchiveSettings(getSetting(db, SETTINGS_KEYS.archive)).autoArchiveSinceMs,
  });
  const service = { ...pluginHandlers(() => host), ...archiveService, getSetting: (key: string) => getSetting(db, key), setSetting: saveSetting, allMuted: (channelIds: readonly string[]) => allMuted(db, channelIds), lastSeenAt: () => lastSeen } as Record<string, (...params: unknown[]) => unknown>;
  // The phone's calls go through the host's phone gateway, as a transport plugin's server hands them over.
  let phone!: PhoneGateway;
  const port: CorePort = {
    installed,
    mediaDir: bundled.mediaDir,
    profileDir: dir,
    call: async (method, ...params) => {
      const fn = service[method];
      if (!fn) throw new Error(`The test harness's core serves no ${method}.`);
      try {
        return structuredClone(await fn(...structuredClone(params)));
      } catch (err) {
        throw new Error(errorMessage(err)); // CoreClient rejects with the message alone
      }
    },
    phone: (call) => phone.call(call.group, call.method, call.params),
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    afterSwitch: [],
  };
  phone = new PhoneHub({ core: { call: port.call as never }, discord: NO_PHONE_EXTRAS, media: NO_PHONE_EXTRAS, active: () => true }).gateway;
  const link = coreLink(port);
  const wire = <T>(value: unknown): T => decodeWire(encodeWire(value)) as T;
  const send = {
    renderer: (name: string, args: unknown[]) => port.call('pluginCall', 'renderer', id, name, args) as Promise<PluginCallResult>,
    main: (name: string, args: unknown[]) => port.call('pluginCall', 'main', id, name, args) as Promise<PluginCallResult>,
    phone: async (name: string, args: unknown[]) => wire<PluginCallResult>(await phone.call('plugins', 'callCore', [id, name, wire(args)])),
  };
  const switchTo = async (on: boolean): Promise<void> => {
    await host.setEnabled(id, on);
    for (const after of port.afterSwitch) await after();
  };
  const row = (pluginId: string) => {
    const found = host.list().find((p) => p.id === pluginId);
    if (!found) throw new Error(`${pluginId} isn't installed in this test.`);
    return found;
  };
  const t: TestPlugin<D> = {
    plugin,
    client: (audience) => clientOver(send[audience]),
    events: (name) => events.flatMap((e) => (e.type === 'plugin-event' && e.pluginId === id && e.name === name ? [e.payload as never] : [])),
    status: (pluginId = id) => ({ status: row(pluginId).status as 'active' | 'disabled' | 'error', error: row(pluginId).error }),
    off: () => switchTo(false),
    on: () => switchTo(true),
    mediaDir: bundled.mediaDir,
    db: pluginDb(() => db, () => true, id),
    archive: {
      arrive: (messages) => {
        const raws = messages.map((m) => rawMessage(m, now));
        archive.ingestMessages(raws, ARRIVAL.gateway);
        // As core's ingest handlers note the change: windows hear it, and plugins' ctx.archive.onChanged.
        const channelIds = [...new Set(raws.map((m) => m.channel_id))];
        emit({ type: 'archive-changed', channelIds });
        host.archiveChanged(channelIds);
        return raws.map((m) => m.id);
      },
      // As the channel list changes it: through core's handler, with the events windows and main act on.
      setChannel: (channelId, policy) => archiveService.setChannelPolicy(channelId, channelPolicy(policy)),
      setPrivacyMode: (on) => saveSetting(SETTINGS_KEYS.privacyMode, on),
    },
    preferences: {
      get: (name) => readPreference(preferenceOf(plugin, name), getSetting(db, pluginSettingKey(id, name))) as never,
      set: (name, value) => saveSetting(pluginSettingKey(id, name), value),
    },
    rules: { run: (type, config, run) => kinds.run(type, config, run), unavailable: (section, type) => kinds.unavailable(section, type) },
    ai: { unavailable: (providerId) => registry.unavailable(providerId) },
    signIn: (userId) => {
      self = userId;
      host.setSelf(userId);
    },
    restart: () => {
      host.endActivations();
      unlinkCore(link);
      db.close();
      return start(definition, o, dir, false);
    },
    link,
    dispose: async () => {
      for (const p of installed) await host.setEnabled(p.manifest.id, false);
      unlinkCore(link);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return t;
}
