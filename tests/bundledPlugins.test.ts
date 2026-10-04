// Bundled plugins (docs/plugins.md → Bundled plugins): which ones a build includes, the host never importing them,
// the core host routing to them, and what the host keeps of features that were built in for their plugins to adopt.
import { ProviderRegistry } from '../src/core/ai/registry';
import { RuleKinds } from '../src/core/rules/kinds';
import { RuleActions } from '../src/core/rules/actions';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kindUnavailable, switchState } from '../src/shared/ruleAvailability';
import { PLUGIN_API_VERSION } from '../src/shared/plugins';
import { defineCorePlugin } from '@plugin-sdk/core';
import { AFTER_MESSAGE, defineChannels, definePlugin, definePreference, defineRuleAction, finiteOr, pluginTable } from '@plugin-sdk/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { BUNDLED_PLUGINS, bundledPanels, bundledJevFeatures, jevQueryPlugin } from '@shared/bundledPlugins';
import { HOST_PANELS } from '@shared/anchors';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { checkBundled } from '@shared/bundledCheck';
import type { AppEvent } from '@shared/contract';
import { RULE_SPEC_VERSION } from '@shared/rules';
import { validateRuleInput } from '@shared/ruleSpec';
import { JEV_QUERIES, JEV_QUERY_GROUPS } from '@shared/jevQueries';
import type { Plugin } from 'vite';
import { bundledPlugins, pluginDirs, pluginFolders, selectedPlugins } from '../bundledPlugins';
import { PRESETS } from '../src/renderer/src/layout/presets';
import { panelIds } from '../src/renderer/src/layout/tree';
import { ARRIVAL, type TextMessage } from '../src/core/arrival';
import { getSetting, setSetting, type Db } from '../src/core/db';
import type { DerivedText, TextSource } from '../src/core/plugins/bundled';
import type { CoreContext, CorePlugin } from '../src/core/plugins/context';
import { partNotes } from '../src/core/attachmentNotes';
import { storeDerivedText } from '../src/core/derivedText';
import { PluginHost } from '../src/core/plugins/host';
import { claimRun, recordOutcome } from '../src/core/rules/ruleStore';
import { adoptBundledData } from '../src/core/plugins/adoption';
import {
  messageQuestions,
  registerMessageQuestion,
  unregisterMessageQuestion,
  type QuestionOwner,
} from '../src/core/jev/messageQuestions';
import { rerunSubjects } from '../src/core/jev/rerun';
import { applyMigrations, migrationIndex, tempDb, tempDir } from './helpers';
import { PLANNER_QUERY, PLANNER_SUBJECT } from './p1Plugins';
import { EVALUATE_TIMEOUT_MS, P1_PLUGIN_DIR, ROOT, evaluateFor, registryFor } from './p1PluginFolders';

// This build: the fixture plugins.
vi.mock('virtual:bundled-plugins/shared', () => import('./p1Registry'));

/** The fixture plugin folders, in folder order. */
const FOLDERS = ['digest', 'inbox', 'labels', 'meter', 'planner', 'poster', 'voice'];
/** A path as generated registries import it. */
const posix = (path: string): string => path.replaceAll('\\', '/');
/** What `bundledPlugins` (`platform`) serves for `id`, with the fixture folders and `selection` (undefined: all). */
const served = (platform: 'node' | 'browser', selection: string | undefined, id: string): string => {
  const plugin = bundledPlugins(ROOT, platform, { dirs: P1_PLUGIN_DIR, selection });
  return (plugin.load as (id: string) => string)((plugin.resolveId as (id: string) => string)(id));
};

describe('build selection', () => {
  it('includes every plugin folder unless CHATTYPOP_PLUGINS names some', () => {
    const folders = pluginFolders([P1_PLUGIN_DIR]);
    expect(selectedPlugins(folders, undefined)).toEqual(FOLDERS);
    expect(selectedPlugins(folders, '')).toEqual([]);
    expect(selectedPlugins(folders, ' none ')).toEqual([]);
    expect(selectedPlugins(folders, ' meter , digest')).toEqual(['digest', 'meter']);
    expect(() => selectedPlugins(folders, 'digest,metre')).toThrow(/metre/);
  });

  it('takes plugin folders only from CHATTYPOP_PLUGIN_DIRS (local plugin-repo clones), in order, refusing a clash', () => {
    const clone = tempDir();
    mkdirSync(join(clone, 'weather'));
    // The app holds no plugin folder of its own.
    expect(pluginDirs(undefined)).toEqual([]);
    const both = `${P1_PLUGIN_DIR}${delimiter}${clone}`;
    expect(pluginDirs(`${both}${delimiter} `)).toEqual([P1_PLUGIN_DIR, clone]);
    const folders = pluginFolders(pluginDirs(both));
    expect([...folders.keys()]).toEqual([...FOLDERS, 'weather']);
    expect(folders.get('weather')).toBe(join(clone, 'weather'));
    expect(() => pluginDirs('relative/plugins')).toThrow(/absolute, existing/);
    expect(() => pluginDirs(join(clone, 'missing'))).toThrow(/absolute, existing/);
    mkdirSync(join(clone, 'labels'));
    expect(() => pluginFolders(pluginDirs(both))).toThrow(/Plugin labels is in two folders/);
  });

  it('compiles in CHATTYPOP_PLUGIN_DIRS only on the dev server: a build that ships, and the host tests, have none', async () => {
    vi.stubEnv('CHATTYPOP_PLUGIN_DIRS', P1_PLUGIN_DIR);
    vi.stubEnv('CHATTYPOP_PLUGINS', undefined);
    try {
      const { default: config } = await import('../electron.vite.config');
      const core = (command: 'serve' | 'build'): string => {
        const plugin = config({ command, mode: command === 'serve' ? 'development' : 'production' }).main!.plugins![0] as Plugin;
        return (plugin.load as (id: string) => string)((plugin.resolveId as (id: string) => string)('virtual:bundled-plugins/core'));
      };
      expect(core('serve')).toContain(posix(join(P1_PLUGIN_DIR, 'meter/core/index.ts')));
      expect(core('build')).not.toContain(posix(P1_PLUGIN_DIR));
      const { testConfig } = await import('../vitest.config');
      const test = testConfig().plugins![0] as Plugin;
      expect((test.load as (id: string) => string)((test.resolveId as (id: string) => string)('virtual:bundled-plugins/core'))).not.toContain(posix(P1_PLUGIN_DIR));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("generates a process's registry from the chosen plugins alone", () => {
    const core = served('node', 'meter', 'virtual:bundled-plugins/core');
    expect(core).toContain(posix(join(P1_PLUGIN_DIR, 'meter/core/index.ts')));
    // Inbox has a core side too, left out with it.
    expect(core).not.toContain('inbox');
    // Meter has no main side, so its main registry lists no build entries, only the installed plugins' sides.
    expect(served('node', 'meter', 'virtual:bundled-plugins/main')).not.toContain(posix(P1_PLUGIN_DIR));
    expect(served('node', 'inbox', 'virtual:bundled-plugins/main')).toContain(posix(join(P1_PLUGIN_DIR, 'inbox/main/index.ts')));
    expect(served('node', '', 'virtual:bundled-plugins/renderer')).toBe('export default [];');
  });

  it('generates browser registries that await the installed plugins after the build’s (§16)', () => {
    // The shared registry lists the build's; @shared/bundledPlugins adds the installed ones, awaited here.
    const installed = served('browser', undefined, 'virtual:installed-plugins/shared');
    expect(installed).toContain('src/renderer/src/plugins/installedShared.ts');
    expect(installed).toMatch(/\nexport default await installedDescriptors\(build, catalog\);$/);
    expect(served('browser', undefined, 'virtual:bundled-plugins/shared')).not.toContain('installed');
    const renderer = served('browser', undefined, 'virtual:bundled-plugins/renderer');
    expect(renderer).toContain(posix(join(P1_PLUGIN_DIR, 'voice/renderer/index.tsx')));
    expect(renderer).toMatch(/\nexport default \[\.\.\.build, \.\.\.\(await installedRenderers\(\)\)\];$/);
    expect(served('browser', 'none', 'virtual:bundled-plugins/renderer')).toMatch(/const build = \[\];/);
  });

  it('registers every plugin of the build, each entry under its folder id', async () => {
    const registry = await registryFor();
    expect(registry.BUNDLED_PLUGINS.map((p) => p.manifest.id)).toEqual(FOLDERS);
    // A plugin without a core side has no core entry.
    const core = await evaluateFor<typeof import('virtual:bundled-plugins/core')>('virtual:bundled-plugins/core');
    expect(core.default.map((e) => e.plugin.manifest.id)).toEqual(FOLDERS.filter((id) => existsSync(join(P1_PLUGIN_DIR, id, 'core', 'index.ts'))));
    expect(registry.ruleActionType('poster.post')).toMatchObject({ actsAsYou: true, liveOnly: true });
    expect(registry.bundledPanel('meter')).toMatchObject({ pluginId: 'meter', dialog: true });
  }, EVALUATE_TIMEOUT_MS);

  it('refuses a registry with a bad id, an action outside its namespace, or a duplicate', () => {
    const p = (id: string, types: string[] = []): PluginDescriptor => ({
      manifest: { id, name: id, version: '1', description: '' },
      rules: { actions: types.map((type) => ({
        type,
        label: '',
        hint: '',
        create: () => null,
        validate: () => undefined,
        targets: ['message'],
        phase: 'after',
        history: false,
        minIntervalMs: null,
        actsAsYou: false,
        liveOnly: false,
      })) },
    });
    expect(() => checkBundled([p('Bad')])).toThrow(/must match/);
    expect(() => checkBundled([p('one', ['two.x'])])).toThrow(/must be one\./);
    expect(() => checkBundled([p('one'), p('one')])).toThrow(/Two bundled plugins/);
  });

  it('gives each tailnet HTTPS port one plugin, publishing a loopback server', () => {
    const tailnet = (id: string, httpsPort: number, loopback = true): PluginDescriptor => ({
      manifest: { id, name: id, version: '1', description: '' },
      network: { ...(loopback ? { loopback } : {}), tailnet: { httpsPort } },
    });
    expect(() => checkBundled([tailnet('one', 8443), tailnet('two', 8444)])).not.toThrow();
    expect(() => checkBundled([tailnet('one', 8443), tailnet('two', 8443)])).toThrow(/tailnet HTTPS port 8443/);
    expect(() => checkBundled([tailnet('one', 0)])).toThrow(/must be a TCP port/);
    expect(() => checkBundled([tailnet('one', 8443, false)])).toThrow(/declare network.loopback/);
  });
});

describe('Jev queries from plugins', () => {
  it('join the catalog in group order, where their anchors place them', () => {
    const ids = JEV_QUERIES.map((q) => q.id);
    expect(ids.indexOf(PLANNER_QUERY)).toBe(ids.indexOf('messages.tags') + 1);
    const groups = JEV_QUERIES.map((q) => JEV_QUERY_GROUPS.indexOf(q.group));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(jevQueryPlugin(PLANNER_QUERY)).toBe('planner');
    expect(bundledJevFeatures().find((f) => f.key === 'planner.planDetection')?.pluginId).toBe('planner');
    expect(jevQueryPlugin('messages.tags')).toBeNull();
  });

  it('re-run on past messages under their own subject', () => {
    expect(rerunSubjects(tempDb(), PLANNER_QUERY)).toEqual(new Set([PLANNER_SUBJECT]));
  });
});

describe('host boundary', () => {
  /** Host code, the Plugin SDK included; plugins live outside the app, in folders PLUGIN_DIRS_ENV names, or installed. */
  const HOST_DIRS = ['src/core', 'src/main', 'src/preload', 'src/renderer/src', 'src/shared', 'src/plugin-sdk'];
  const SOURCE_ROOT = join(ROOT, 'src');
  /** The registries the build generates: the only modules through which host code reaches plugin code. */
  const REGISTRY_PREFIXES = ['virtual:bundled-plugins/', 'virtual:installed-plugins/'];
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const ALIASES: Record<string, string> = {
    '@shared/': 'src/shared/',
    '@core/': 'src/core/',
    '@main/': 'src/main/',
    '@plugin-sdk/': 'src/plugin-sdk/',
    // The host test kit plugin tests import (vitest.config.ts): never host code's.
    '@chattypop/host-testing': 'tests/hostTesting',
    '@/': 'src/renderer/src/',
  };
  const target = (file: string, spec: string): string | null => {
    const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a));
    if (alias) return join(ROOT, ALIASES[alias]!, spec.slice(alias.length));
    if (isAbsolute(spec)) return spec;
    return spec.startsWith('.') ? resolve(dirname(file), spec) : null;
  };
  const imports = HOST_DIRS.flatMap((d) => files(join(ROOT, d))).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => ({ file, spec: m[1]! })),
  );

  it('no host module imports a plugin: every import by path stays in the app’s source', () => {
    const offenders = imports
      .map(({ file, spec }) => ({ file, to: target(file, spec) }))
      .filter((i): i is { file: string; to: string } => i.to !== null && relative(SOURCE_ROOT, i.to).startsWith('..'))
      .map(({ file, to }) => `${relative(ROOT, file)} → ${to}`);
    expect(offenders).toEqual([]);
  });

  it('plugins come only through the virtual registries', () => {
    const virtual = imports.filter(({ spec }) => spec.startsWith('virtual:'));
    expect(virtual.length).toBeGreaterThan(0);
    expect(virtual.filter(({ spec }) => !REGISTRY_PREFIXES.some((p) => spec.startsWith(p))).map(({ spec }) => spec)).toEqual([]);
  });

  it("presets name only panels a build can provide: the host's or a plugin's", () => {
    const known = new Set<string>([...HOST_PANELS, ...bundledPanels().map((p) => p.id)]);
    const named = Object.values(PRESETS).flatMap((doc) => panelIds(doc.root));
    expect(named.filter((id) => !known.has(id))).toEqual([]);
  });
});

describe('rules whose plugin is missing', () => {
  it('keep loading and saving without their plugin, which says why they cannot run', () => {
    const spec = {
      v: RULE_SPEC_VERSION,
      trigger: { type: 'message', config: null },
      gates: { edits: false, missed: false },
      match: [],
      narrow: [],
      actions: [{ id: 'p', type: 'nope.post', config: {} }],
    };
    expect(() => validateRuleInput({ name: 'x', enabled: true, discordSend: true, spec } as never)).not.toThrow();
    expect(kindUnavailable('nope.post', () => switchState(true))).toBe("Needs the nope plugin, which this ChattyPop doesn't include.");
  });
});

describe('core plugin host with bundled plugins', () => {
  let db: Db;
  let events: AppEvent[];
  let seen: [string, TextSource][];
  /** Derived texts the probe settled (host storeText), and texts settled as its onSettled saw them. */
  let stored: [string, string, DerivedText][];
  let settled: string[];
  /** What the probe's hooks heard. */
  let heard: string[];
  /** Each (re)activation of the probe; each deactivation. */
  let probeKinds: RuleKinds;
  let activations: number;
  let deactivations: number;
  /** The probe's latest context, as a job still running after it is turned off would hold it. */
  let held: CoreContext<typeof probePlugin>;
  interface ProbeCore {
    settle(messageId: string, text: string | null): void;
    shout(): void;
    fromMain(): string;
    importBad(): void;
  }
  const probePlugin = definePlugin({
    manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
    rules: { actions: [
      defineRuleAction({
        type: 'probe.act',
        label: '',
        hint: '',
        create: () => null,
        validate: () => undefined,
        targets: ['message'],
        phase: 'after',
        history: false,
        minIntervalMs: null,
        actsAsYou: false,
        liveOnly: false,
      }),
    ] },
    channels: defineChannels<{ core: ProbeCore; events: { shout: number } }>()({
      core: { settle: ['renderer'], shout: ['renderer'], fromMain: ['main'], importBad: ['renderer'] },
      events: { shout: ['renderer'] },
    }),
    preferences: {
      self: definePreference<string | null>({ default: null, normalize: (v: unknown) => (typeof v === 'string' ? v : null) }),
      key: definePreference<number | null>({ default: null, normalize: finiteOr(null) }),
    },
  });
  const probe: CorePlugin = defineCorePlugin(probePlugin, (ctx) => {
    activations++;
    held = ctx;
    ctx.rules.action('probe.act', (config, run) => ({
      outcome: 'done',
      detail: `${String(config)} on ${run.event.kind === 'message' ? run.event.m.id : 'window'}`,
    }));
    ctx.archive.onText((m, _arrived, source) => void seen.push([m.id, source]));
    ctx.identity.onSelf((id) => ctx.preferences.set('self', id));
    ctx.jev.questions.register({ subject: 'probe', feature: 'pluginDecide', question: () => null });
    ctx.archive.derivedText.provide({ pending: (id) => id === 'coming' });
    ctx.archive.derivedText.onSettled((id) => void settled.push(id));
    ctx.archive.attachmentNotes.provide(
      (ids) => new Map(ids.map((id) => [id, { kind: 'probe', state: 'done', label: 'probe', text: `note on ${id}` }])),
    );
    ctx.archive.onAttachmentStored((id) => void heard.push(`stored ${id}`));
    ctx.preferences.onChange('key', (value) => void heard.push(`setting ${value}`));
    ctx.channels.serve({
      settle: (messageId, text) =>
        ctx.archive.derivedText.settle(messageId, text === null ? null : { key: 'k', order: 1, text, queuedAt: 5 }),
      shout: () => ctx.channels.emit('shout', 1),
      fromMain: () => 'main only',
      importBad: () => {
        throw new Error('Not a DiscordChatExporter file.');
      },
    });
    return () => void deactivations++;
  });
  const m: TextMessage = { id: 'm1', channelId: 'c', authorId: 'u', ts: 1, content: 'hi', linked: '' };
  const live = { via: ARRIVAL.gateway, at: 1, edit: false };
  const runProbeAction = () => new RuleActions(db, probeKinds).run(
    { id: 'a', type: 'probe.act', config: 'ping' },
    {
      rule: { id: 1, name: '', managed: null, armedAt: 0, discordSend: false },
      actionId: 'a',
      runId: 1,
      history: false,
      event: {
        kind: 'message',
        eventId: 1,
        m,
        live: true,
        liveAt: 1,
        hit: { kind: 'pattern', probability: null, highlight: null },
      },
    },
  );
  const make = (dir = tempDir()): PluginHost =>
    new PluginHost(
      dir,
      {
        db,
        emit: (e) => events.push(e),
        changed: () => undefined,
        ai: async () => ({ text: '' }),
        decider: () => null,
        bundled: {
          rules: probeKinds,
          ready: () => db,
          archive: () => {
            throw new Error('no archive');
          },
          mediaDir: tempDir(),
          attachmentsDir: tempDir(),
          pluginData: { root: tempDir(), unmoved: {} },
          storeText: (pluginId, messageId, t) => void stored.push([pluginId, messageId, t]),
          catchUp: () => undefined,
          storeLinkText: () => undefined, storeLinkImages: () => undefined,
          saveSetting: (key, value) => setSetting(db, key, value),
          aiSettings: () => {
            throw new Error('no AI');
          },
          providers: new ProviderRegistry(() => undefined),
          decider: () => null,
          now: Date.now,
        },
      },
      [probe],
    );
  beforeEach(() => {
    (BUNDLED_PLUGINS as PluginDescriptor[]).push(probePlugin);
    probeKinds = new RuleKinds();
    db = tempDb();
    events = [];
    seen = [];
    stored = [];
    settled = [];
    heard = [];
    activations = 0;
    deactivations = 0;
  });

  afterEach(() => {
    const list = BUNDLED_PLUGINS as PluginDescriptor[];
    const index = list.indexOf(probePlugin);
    if (index >= 0) list.splice(index, 1);
  });

  it('routes rule actions, texts and the signed-in user to the plugin; lists it as bundled', async () => {
    const host = make();
    host.setSelf('me'); // before load: handed over when the plugin registers
    await host.loadAll();
    expect(host.list()).toMatchObject([{ id: 'probe', bundled: true, status: 'active', dir: '' }]);
    expect(getSetting(db, 'plugin.probe.self')).toBe('me');
    await expect(
      Promise.resolve(runProbeAction()),
    ).resolves.toEqual({ outcome: 'done', detail: 'ping on m1' });
    host.dispatchMessage(m, live, 'transcript');
    expect(seen).toEqual([['m1', 'transcript']]);
  });

  it('takes derived text, pending text, attachment notes, hooks and events from a plugin; drops them when it is off', async () => {
    const host = make();
    await host.loadAll();
    await host.call('renderer', 'probe', 'settle', ['m1', 'said']);
    await host.call('renderer', 'probe', 'settle', ['m2', null]);
    expect(stored).toEqual([['probe', 'm1', { key: 'k', order: 1, text: 'said', queuedAt: 5 }]]);
    expect(settled).toEqual(['m1', 'm2']);
    expect([host.textPending('coming'), host.textPending('m1')]).toEqual([true, false]);
    expect(partNotes([{ id: 'm1', attachmentIds: ['a1'] }]).get('m1')?.get('attachment:a1')).toEqual([
      { pluginId: 'probe', part: 'attachment:a1', kind: 'probe', state: 'done', label: 'probe', text: 'note on a1' },
    ]);
    host.attachmentStored('a1');
    host.settingChanged('other');
    setSetting(db, 'plugin.probe.key', 7);
    host.settingChanged('plugin.probe.key');
    expect(heard).toEqual(['stored a1', 'setting 7']);
    await host.call('renderer', 'probe', 'shout', []);
    expect(events).toContainEqual({ type: 'plugin-event', pluginId: 'probe', name: 'shout', payload: 1 });
    await host.setEnabled('probe', false);
    host.attachmentStored('a2');
    host.settingChanged('plugin.probe.key');
    expect([host.textPending('coming'), partNotes([{ id: 'm1', attachmentIds: ['a1'] }]).size, heard.length]).toEqual([false, 0, 2]);
    // A job finishing after the switch stores nothing and tells no one.
    held.archive.derivedText.settle('m3', { key: 'k', order: 1, text: 'late', queuedAt: 5 });
    expect([stored.length, settled]).toEqual([1, ['m1', 'm2']]);
  });

  it('answers each call only for the audiences its contract declares, as the transport stamped the origin', async () => {
    const host = make();
    await host.loadAll();
    await expect(host.call('renderer', 'probe', 'fromMain', [])).rejects.toThrow(
      'has no function fromMain for renderer',
    );
    await expect(host.call('phone', 'probe', 'shout', [])).rejects.toThrow('has no function shout for phone');
    await expect(host.call('main', 'probe', 'fromMain', [])).resolves.toBe('main only');
    await expect(host.call('main', 'probe', 'shout', [])).rejects.toThrow('has no function shout for main');
  });

  it('refuses derived text that would read before the content', () => {
    expect(() => storeDerivedText(db, 'm1', 'p:k', 0, 'x')).toThrow(/positive integer/);
  });

  it("stores a plugin's own record with its derived text, or neither", () => {
    db.exec('CREATE TABLE p_probe_jobs (state TEXT)');
    const record = (): void => void db.prepare("INSERT INTO p_probe_jobs VALUES ('done')").run();
    const count = (table: string): unknown => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    expect(() => storeDerivedText(db, 'm1', 'p:k', 1, null as never, record)).toThrow(/NOT NULL/);
    expect([count('p_probe_jobs'), count('derived_texts')]).toEqual([0, 0]);
    storeDerivedText(db, 'm1', 'p:k', 1, 'said', record);
    expect([count('p_probe_jobs'), count('derived_texts')]).toEqual([1, 1]);
  });

  it('skips the actions of a plugin that is off, and gives it nothing', async () => {
    setSetting(db, 'plugins.disabled', ['probe']);
    const host = make();
    await host.loadAll();
    await expect(
      Promise.resolve(runProbeAction()),
    ).resolves.toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/Probe plugin, which is off/) });
    host.dispatchMessage(m, live, 'message');
    expect(seen).toEqual([]);
  });

  it("keeps a bundled plugin running through Reload and other plugins' switches; its own switch loads or unloads it alone", async () => {
    const host = make();
    await host.loadAll();
    await host.reload();
    await host.setEnabled('someone-else', false);
    expect([activations, deactivations]).toEqual([1, 0]);
    await host.setEnabled('probe', false);
    expect(host.list()[0]).toMatchObject({ status: 'disabled', error: null });
    await host.setEnabled('probe', true);
    expect([activations, deactivations]).toEqual([2, 1]);
    expect(host.list()[0]).toMatchObject({ status: 'active' });
  });

  it('starts bundled plugins synchronously, so their Jev questions are in the startup catch-up; drops them when off', async () => {
    const host = make();
    host.startBundled();
    expect(messageQuestions().some((q) => q.subject === 'probe')).toBe(true);
    await host.loadAll(); // folders only: the probe is not started twice
    expect(activations).toBe(1);
    await host.setEnabled('probe', false);
    expect(messageQuestions().some((q) => q.subject === 'probe')).toBe(false);
  });

  it('orders Jev questions by owner (host, plugins in build order, custom tags), whenever each registered', () => {
    const owners: [string, QuestionOwner][] = [
      ['q-tag', { plugin: 'p0', buildIndex: 0, forOwner: true }],
      ['q-p1', { plugin: 'p1', buildIndex: 1 }],
      ['q-p0', { plugin: 'p0', buildIndex: 0 }],
      ['q-host', 'host'],
    ];
    const add = (subject: string, owner: QuestionOwner): void =>
      void registerMessageQuestion({ subject, feature: 'pluginDecide', question: () => null }, owner);
    const order = (): string[] =>
      messageQuestions()
        .map((q) => q.subject)
        .filter((s) => s.startsWith('q-'));
    owners.forEach(([s, o]) => add(s, o));
    expect(order()).toEqual(['q-host', 'q-p0', 'q-p1', 'q-tag']);
    unregisterMessageQuestion('q-p0'); // its plugin turned off, then on again
    add('q-p0', { plugin: 'p0', buildIndex: 0 });
    expect(order()).toEqual(['q-host', 'q-p0', 'q-p1', 'q-tag']);
    owners.forEach(([s]) => unregisterMessageQuestion(s));
  });

  it("gives a bundled plugin's failing call to its caller without marking the plugin failed", async () => {
    const host = make();
    await host.loadAll();
    await expect(host.call('renderer', 'probe', 'importBad', [])).rejects.toThrow('Not a DiscordChatExporter file.');
    expect(host.list()[0]).toMatchObject({ status: 'active', error: null });
  });

  it('keeps a plugins-folder plugin from taking a bundled id', async () => {
    const dir = tempDir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'probe'));
    writeFileSync(
      join(dir, 'probe', 'plugin.json'),
      JSON.stringify({ id: 'probe', version: '1', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }),
    );
    writeFileSync(join(dir, 'probe', 'main.mjs'), 'export function activate() {}');
    const host = make(dir);
    await host.loadAll();
    expect(host.list().find((p) => !p.bundled)).toMatchObject({
      status: 'error',
      error: 'ChattyPop already includes plugin probe',
    });
  });
});

describe('features that were built in: what the host keeps for their plugins', () => {
  let db: Db;
  const load = async (entry: CorePlugin): Promise<PluginHost> => {
    const host = new PluginHost(
      tempDir(),
      {
        db,
        emit: () => undefined,
        changed: () => undefined,
        ai: async () => ({ text: '' }),
        decider: () => null,
        bundled: {
          rules: new RuleKinds(),
          ready: () => db,
          archive: () => null as never,
          mediaDir: tempDir(),
          attachmentsDir: tempDir(),
          pluginData: { root: tempDir(), unmoved: {} },
          storeText: () => undefined,
          catchUp: () => undefined,
          storeLinkText: () => undefined, storeLinkImages: () => undefined,
          saveSetting: (key, value) => setSetting(db, key, value),
          aiSettings: () => null as never,
          providers: new ProviderRegistry(() => undefined),
          decider: () => null,
          now: Date.now,
        },
      },
      [entry],
    );
    adoptBundledData(db, [entry.plugin]); // as core init does, before plugins start
    await host.loadAll();
    expect(host.list()[0]).toMatchObject({ status: 'active', error: null });
    return host;
  };
  beforeEach(() => {
    db = tempDb();
  });

  it('a plugin adopts its built-in table, with what it holds, and the actions rules recorded under the old kind', async () => {
    const keeper = definePlugin({
      manifest: { id: 'keeper', name: 'Keeper', version: '1', description: '' },
      rules: { actions: [defineRuleAction({ ...AFTER_MESSAGE, type: 'keeper.post', label: '', hint: '', create: () => null, validate: () => undefined })] },
      adopts: { tables: { legacy_items: 'items' }, actionKinds: { legacyPost: 'keeper.post' } },
    });
    db.exec("CREATE TABLE legacy_items (title TEXT); INSERT INTO legacy_items VALUES ('Game night')");
    db.prepare(
      "INSERT INTO rules (name, spec, enabled, position, armed_at, discord_send, created_at) VALUES ('r', '{}', 1, 0, 0, 1, 0)",
    ).run();
    const runId = claimRun(db, 1, 'msg:m1', null, true, 1)!;
    recordOutcome(db, runId, 'p', 'legacyPost', 'done', null, 1);
    // In this build's registry, as its rule action must be.
    const list = BUNDLED_PLUGINS as PluginDescriptor[];
    list.push(keeper);
    try {
      await load(defineCorePlugin(keeper, (ctx) => ctx.rules.action('keeper.post', () => ({ outcome: 'done', detail: 'posted' }))));
    } finally {
      list.splice(list.indexOf(keeper), 1);
    }
    const items = pluginTable(keeper, 'items');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('legacy_items', ?)").pluck().all(items)).toEqual([items]);
    expect(db.prepare(`SELECT title FROM ${items}`).pluck().all()).toEqual(['Game night']);
    expect(db.prepare('SELECT kind FROM rule_action_runs').pluck().all()).toEqual(['keeper.post']);
  });

  it('done transcripts become derived text in their order, searchable as before; every job stays for its plugin', () => {
    db = new Database(join(tempDir(), 'old.db')) as unknown as Db;
    const cut = migrationIndex('CREATE TABLE derived_texts');
    applyMigrations(db, 0, cut);
    const job = db.prepare(
      `INSERT INTO transcripts (seq, attachment_id, message_id, state, text, priority, requested_at) VALUES (?, ?, 'm1', ?, ?, 0, 1)`,
    );
    job.run(7, 'a1', 'done', 'hello lighthouse');
    job.run(8, 'a2', 'failed', null);
    applyMigrations(db, cut);
    expect(db.prepare('SELECT seq, message_id AS m, source, ord, text FROM derived_texts').all()).toEqual([
      { seq: 7, m: 'm1', source: 'transcription:a1', ord: 7, text: 'hello lighthouse' },
    ]);
    expect(
      db.prepare(`SELECT rowid FROM fts_derived_texts WHERE fts_derived_texts MATCH 'lighthouse'`).pluck().all(),
    ).toEqual([7]);
    expect(db.prepare('SELECT attachment_id FROM transcripts ORDER BY seq').pluck().all()).toEqual(['a1', 'a2']);
  });
});
