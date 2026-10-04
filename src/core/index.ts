// Core process: runs in an Electron utilityProcess. Owns SQLite; later AI and plugins.
import { join } from 'node:path';
import bundledCore, { failed as failedCore } from 'virtual:bundled-plugins/core';
import {
  ARCHIVE_ATTACHMENTS_DIR,
  ARCHIVE_DB_FILE,
  ARCHIVE_MEDIA_DIR,
  type AppEvent,
  type CoreEventMessage,
  type CoreInit,
  type CoreMethods,
  type CoreRequest,
  type CoreResponse,
} from '@shared/contract';
import { userNames, type RawUser } from '@shared/discord';
import { errorMessage } from '@shared/errors';
import { SETTINGS_KEYS, normalizeArchiveSettings } from '@shared/settings';
import { aiSettingsFrom } from '@shared/aiProviders';
import { MS_PER_DAY, MS_PER_HOUR } from '@shared/units';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { installedStart } from '@main/plugins/installed/runtime';
import type { DecisionProvider } from './ai/decisions';
import { ProviderRegistry } from './ai/registry';
import { scopedCompletion } from './ai/readScope';
import { Archive } from './archive';
import type { Arrived, TextMessage } from './arrival';
import { rederiveIfStale } from './derive/rederive';
import { enforceAttachmentCap } from './attachmentRetention';
import { archiveHandlers } from './archiveHandlers';
import { DirSize } from './diskUsage';
import { getSetting, openDb, readStatus, rekey, setSetting, type Db } from './db';
import { TextRetentionRunner, applyTextRetention } from './textRetention';
import { suggestChannels } from './channelSuggestions';
import { localOnlyChannelIds } from './channelPolicy';
import { mediaQueueHandlers } from './mediaQueue';
import { aiHandlers } from './aiHandlers';
import { registerClasses } from './jev/classes';
import { registerNotable } from './jev/notable';
import { registerTags } from './jev/tags';
import { JevSpendLedger } from './jevSpend';
import { startLastSeen } from './lastSeen';
import type { BundledDeps } from './plugins/bundled';
import { PluginHost } from './plugins/host';
import { adoptBundledData } from './plugins/adoption';
import { absentPlugins } from './plugins/footprints';
import { jevQueryHandlers, loadJevQueryOverrides } from './jevQueryHandlers';
import { setJevQueryOverrides } from './jev/queries';
import { pluginHandlers, queryHandlers, ruleHandlers } from './serviceHandlers';
import { createRuleActions } from './rules/hostKinds';
import { RuleEngine } from './rules/engine';
import { RuleMatcher } from './rules/matcher';
import { RuleSchedule } from './rules/schedule';
import { RuleService } from './rules/ruleService';
import { addedTextArrival, textMessage } from './queries/messageText';
import { allMuted } from './queries/notificationMute';
import { storeDerivedText, storeLinkText } from './derivedText';
import { storeLinkImages } from './messageImages';
import { watchNameWrites } from './nameWrites';

/** Coalesces bursts of archive writes into one UI refresh. */
const CHANGE_EVENT_DEBOUNCE_MS = 250;

let db: Db | undefined;
let archive: Archive | undefined;
let dbPath = '';
let initError: Error | undefined;
/** Every answered Jev request is priced here, whichever feature asked. */
const jevLedger = new JevSpendLedger(
  () => db ?? null,
  (spend) => emit({ type: 'jev-spend', spend }),
);
const providers = new ProviderRegistry((questions, usd, tokens) => jevLedger.record(questions, usd, tokens));
let ruleSchedule: RuleSchedule | undefined;
/** The signed-in Discord user (main sends it after sign-in); null until then. */
let self: RawUser | null = null;
let ruleService: RuleService | undefined;
/** The shared rule engine; plugin triggers register against its kinds. */
let ruleEngine: RuleEngine | undefined;
/** Every stored message text runs through it; created with the engine. */
let ruleMatcher: RuleMatcher | undefined;
let plugins: PluginHost | undefined;
/** Settles once the plugins folder has loaded, so every plugin is listed. */
let pluginsLoaded: Promise<void> | undefined;
/** Plugins' data folders (PluginDataDirs.root). */
let pluginDataRoot = '';
/** Media store size measured on disk (media/ holds attachments and cached icons). */
let mediaSize: DirSize | undefined;
let attachmentsDir = '';
/** Whether the database is encrypted (a key was given at init or set since). */
let encrypted = false;

let previousSessionSeenAt = 0;

function ready(): { db: Db; archive: Archive } {
  if (initError) throw initError;
  if (!db || !archive) throw new Error('core not initialised');
  return { db, archive };
}

function emit(event: AppEvent): void {
  process.parentPort.postMessage({ kind: 'event', event } satisfies CoreEventMessage);
}

const changed = new Set<string>();
let namesChanged = false;
let changeTimer: NodeJS.Timeout | undefined;
function noteChanged(channelId: string): void {
  changed.add(channelId);
  changeTimer ??= setTimeout(() => {
    emit({ type: 'archive-changed', channelIds: [...changed], ...(namesChanged ? { namesChanged: true } : {}) });
    namesChanged = false;
    // '' marks a change to no channel (disk use, a plugin's own refresh): plugins hear only about messages.
    const channelIds = [...changed].filter((id) => id !== '');
    if (channelIds.length) plugins?.archiveChanged(channelIds);
    changed.clear();
    changeTimer = undefined;
  }, CHANGE_EVENT_DEBOUNCE_MS);
}

/** True when a request changed name data (nameWrites.ts); set once the archive is open. */
let namesWritten: (() => boolean) | undefined;

/** Members or roles changed: the names views show, and their colours and marks, may differ. */
function noteNamesChanged(): void {
  namesChanged = true;
  noteChanged('');
}

/** A service created at init, once the core is ready; each accessor stays a closure so it reads the current value. */
const need = <T>(service: T | undefined): T => {
  ready();
  return service!;
};
const matcher = (): RuleMatcher => need(ruleMatcher);
const rulesOf = (): RuleService => need(ruleService);

const archiveSettings = () => normalizeArchiveSettings(getSetting(ready().db, SETTINGS_KEYS.archive));
/** Start of the history window sync fills (Settings → Archive → days of history). */
const backfillFromMs = (): number => Date.now() - archiveSettings().backfillDays * MS_PER_DAY;

/** Enforces Settings → Archive → attachment cap (oldest files pruned first); a no-op when the cap is off. */
function applyAttachmentCap(): void {
  const db = ready().db;
  if (enforceAttachmentCap(db, attachmentsDir, archiveSettings().attachmentCapGb)) noteChanged('');
}

/** Text retention re-runs this often so messages move to their tier as they age. */
const TEXT_RETENTION_INTERVAL_MS = MS_PER_HOUR;
/** Enforces Settings → Archive text tier and database cap. */
const retention = new TextRetentionRunner(
  () => applyTextRetention(ready().db, archiveSettings(), Date.now(), aiSettings().jev.keepImportant),
  () => noteChanged(''),
);
const applyTextTier = (): Promise<void> => retention.request();

/** A Jev decider for a per-feature switch, or a message naming the switch to turn on. */
function requireDecider(feature: Parameters<ProviderRegistry['decider']>[1], hint: string): DecisionProvider {
  const jev = deciderFor(feature);
  if (!jev) throw new Error(hint);
  return jev;
}


const host = (): PluginHost => need(plugins);

/** Settings → AI: each provider's switch, model and effort, and the Jev switches. */
const aiSettings = () => aiSettingsFrom(getSetting(ready().db, SETTINGS_KEYS.ai));
/** Jev for a feature the user turned on (and a key pays for), else null; Settings apply at once. */
const deciderFor = (feature: Parameters<ProviderRegistry['decider']>[1]): DecisionProvider | null =>
  providers.decider(aiSettings(), feature);

const handlers: { [M in keyof CoreMethods]: (...p: Parameters<CoreMethods[M]>) => ReturnType<CoreMethods[M]> } = {
  ...aiHandlers({
    db: () => ready().db,
    providers,
    jevLedger,
    aiSettings,
    requireDecider,
    emit,
  }),
  ...jevQueryHandlers(
    () => ready().db,
    () => matcher(),
  ),
  setSelf: (user) => {
    self = user;
    matcher().setSelf(user);
    host().setSelf(user.id);
    emit({ type: 'self-changed', userId: user.id });
  },
  selfId: () => self?.id ?? null,
  syncSettled: () => ruleSchedule?.archiveCurrent(),
  lastSeenAt: () => previousSessionSeenAt,
  status: async () => ({
    ...readStatus(ready().db, dbPath, await mediaSize!.get(), encrypted),
    textOverCapBytes: retention.overCapBytes,
  }),
  getSetting: (key) => getSetting(ready().db, key),
  allMuted: (channelIds) => allMuted(ready().db, channelIds),
  setSetting: (key, value) => {
    setSetting(ready().db, key, value);
    emit({ type: 'setting-changed', key, value });
    if (key === SETTINGS_KEYS.jevQueries) setJevQueryOverrides(value);
    plugins?.settingChanged(key);
    if (key === SETTINGS_KEYS.ai) {
      matcher().requestCatchUp(); // Jev may just have been turned on
    }
    if (key === SETTINGS_KEYS.archive) {
      applyAttachmentCap();
      void applyTextTier();
    }
    if (key === SETTINGS_KEYS.privacyMode) emit({ type: 'privacy-changed' });
  },
  ...archiveHandlers({
    ready,
    emit,
    noteChanged,
    noteNamesChanged,
    backfillFromMs,
    selfId: () => self?.id ?? null,
    lastSeenAt: () => previousSessionSeenAt,
    applyTextTier: () => applyTextTier(),
    autoArchiveSinceMs: () => archiveSettings().autoArchiveSinceMs,
  }),
  ...ruleHandlers(rulesOf, () => ready().db),
  ...pluginHandlers(host),
  absentPlugins: async () => {
    await need(pluginsLoaded);
    return absentPlugins(ready().db, pluginDataRoot, host().list().map((p) => p.id));
  },
  suggestChannels: (samples) =>
    suggestChannels(
      requireDecider('suggestChannels', 'Turn on Settings → Jev → Suggest channels to archive (and set a Jev key).'),
      rulesOf().list(),
      samples,
      localOnlyChannelIds(ready().db),
    ),
  setEncryption: (key) => {
    rekey(ready().db, key);
    encrypted = key !== null;
  },
  closeArchive: () => {
    const { db: open } = ready();
    plugins?.endActivations(); // before the close: their last writes (deactivate, pending work) still land
    jevLedger.flush(); // the app restarts after the move, so an unwritten tally would be lost
    open.pragma('wal_checkpoint(TRUNCATE)');
    open.close();
    initError = new Error('The archive is being moved; ChattyPop restarts when it is done.');
  },
  integrityCheck: () => String(ready().db.pragma('quick_check', { simple: true })),
  ...queryHandlers(
    () => ready().db,
    () => self?.id ?? null,
  ),
  ...mediaQueueHandlers(
    () => ready().db,
    (id) => {
      plugins?.attachmentStored(id); // before the cap may prune it
      applyAttachmentCap();
      noteChanged(''); // disk usage changed; channel-less change refreshes status only
    },
  ),
};

function reply(msg: CoreResponse): void {
  process.parentPort.postMessage(msg);
}

process.parentPort.on('message', async ({ data }: { data: CoreInit | CoreRequest }) => {
  if ('kind' in data) {
    dbPath = join(data.archiveDir, ARCHIVE_DB_FILE);
    mediaSize = new DirSize(join(data.archiveDir, ARCHIVE_MEDIA_DIR));
    attachmentsDir = join(data.archiveDir, ARCHIVE_MEDIA_DIR, ARCHIVE_ATTACHMENTS_DIR);
    try {
      db = openDb(dbPath, data.key);
      namesWritten = watchNameWrites(db);
      encrypted = data.key !== null;
      loadJevQueryOverrides(db);
      registerNotable();
      registerClasses();
      registerTags();
      const ruleActions = createRuleActions(
        db,
        {
          runPluginCommand: async (pluginId, commandId, range) => {
            if (!plugins) throw new Error('Plugins are not ready yet.');
            return plugins.runCommand(pluginId, commandId, range);
          },
        },
        emit,
        Date.now,
      );
      const rules = (ruleEngine = new RuleEngine(db, emit, ruleActions));
      const watcher = (ruleMatcher = new RuleMatcher(db, rules, deciderFor));
      const service = (ruleService = new RuleService(db, emit, rules, watcher));
      const archiveDb = db;
      // Text a message's links gained after it arrived (a late Discord preview, a fetched post): it is judged again.
      const linkedText = (m: TextMessage, arrived: Arrived): void => watcher.check(m, arrived);
      const bundled: BundledDeps = {
        rules: rules.kinds,
        ready: () => ready().db,
        archive: () => ready().archive,
        mediaDir: join(data.archiveDir, ARCHIVE_MEDIA_DIR),
        attachmentsDir,
        pluginData: data.pluginData,
        // Derived text is new text for its message: rules, Jev's per-message questions and plugins see it as an edit.
        // Its arrival is when its source was queued, so a live voice message's transcript counts as live however long it took.
        storeText: (pluginId, messageId, t, record) => {
          storeDerivedText(archiveDb, messageId, `${pluginId}:${t.key}`, t.order, t.text, record, t.part ?? null);
          const m = textMessage(archiveDb, messageId);
          if (!m) return;
          const arrived = addedTextArrival(archiveDb, messageId, t.queuedAt);
          // The text is stored either way: a failing rule check is logged, not the plugin's failure.
          try {
            watcher.check(m, arrived, t.askJev ?? true);
          } catch (err) {
            console.error('[derived text] rule check failed', err);
          }
          pluginHost.dispatchMessage(m, arrived, 'transcript'); // set below, before any plugin runs
        },
        storeLinkText: (pluginId, url, text, record) => {
          for (const id of storeLinkText(archiveDb, url, pluginId, text, record)) {
            const m = textMessage(archiveDb, id);
            if (m) linkedText(m, addedTextArrival(archiveDb, id, Date.now()));
          }
        },
        storeLinkImages: (pluginId, url, images, record) => {
          for (const id of storeLinkImages(archiveDb, url, pluginId, images, record)) pluginHost.imagesShown(id);
        },
        saveSetting: (key, value) => handlers.setSetting(key, value),
        aiSettings,
        providers,
        decider: deciderFor,
        catchUp: () => watcher.requestCatchUp(),
        now: Date.now,
        lastSeenAt: () => previousSessionSeenAt,
        readerNames: () => self ? userNames(self) : null,
      };
      plugins = new PluginHost(
        data.pluginsDir,
        { db, emit, changed: noteChanged, ai: scopedCompletion(() => ready().db, providers, aiSettings), decider: () => deciderFor('pluginDecide'), bundled },
        bundledCore,
        BUNDLED_PLUGINS,
        { start: installedStart(), failed: failedCore },
      );
      const pluginHost = plugins;
      archive = new Archive(
        db,
        (m, arrived) => {
          watcher.check(m, arrived);
          pluginHost.dispatchMessage(m, arrived, 'message');
        },
        linkedText,
        (id) => pluginHost.imagesShown(id),
      );
      adoptBundledData(db, BUNDLED_PLUGINS); // before any plugin reads its tables or settings
      previousSessionSeenAt = startLastSeen(() => db);
      pluginHost.startBundled(); // before any Jev catch-up (syncBuiltins may start one), so their questions ride in it
      // After archive is set: aiSettings() reads through ready().
      watcher.requestCatchUp(); // judgments an earlier session didn't finish
      rederiveIfStale(db, () => pluginHost.linksRebuilt());
      applyAttachmentCap();
      void applyTextTier();
      setInterval(() => void applyTextTier().catch(() => undefined), TEXT_RETENTION_INTERVAL_MS); // fails only while the archive is moving
      pluginDataRoot = data.pluginData.root;
      pluginsLoaded = pluginHost.loadAll();
      ruleSchedule = new RuleSchedule(db, rules, ruleActions, previousSessionSeenAt, emit);
    } catch (err) {
      initError = err instanceof Error ? err : new Error(String(err));
    }
    return;
  }
  try {
    const handler = handlers[data.method] as (...p: unknown[]) => unknown;
    reply({ id: data.id, ok: true, result: await handler(...data.params) });
  } catch (err) {
    reply({ id: data.id, ok: false, error: errorMessage(err) });
  } finally {
    if (namesWritten?.()) noteNamesChanged();
  }
});
