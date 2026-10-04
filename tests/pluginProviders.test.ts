// AI provider registry contracts (docs/plugin-architecture.md §3, AI providers), against probe plugins: declaration
// checks, registration and routing by id, status and plan usage, turning a provider's plugin off, and stored settings.
import { describe, expect, it, onTestFinished } from 'vitest';
import { AFTER_MESSAGE, definePlugin, defineRuleAction } from '@plugin-sdk/shared';
import { defineCorePlugin, type LlmProvider, type ProviderImpl } from '@plugin-sdk/core';
import { providerDeclarations } from '@shared/aiProviders';
import { type PluginDescriptor } from '@shared/bundledTypes';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import { checkBundled } from '@shared/bundledCheck';
import { normalizeAiSettings } from '@shared/settings';
import { ProviderRegistry } from '../src/core/ai/registry';
import type { CoreContext, CorePlugin } from '../src/core/plugins/context';
import { TURNED_OFF } from '../src/core/ai/types';
import { setSetting } from '../src/core/db';
import { tempDb } from './helpers';
import { startProviders } from './providerHost';

const probe = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  providers: [
    { id: 'probe', label: 'Probe · remote', displayName: 'Probe', enabledByDefault: true, planUsage: true },
    { id: 'probe.local', label: 'Probe · local', displayName: 'Local probe', enabledByDefault: false, local: true },
  ],
});
const other = definePlugin({
  manifest: { id: 'other', name: 'Other', version: '1', description: '' },
  providers: [{ id: 'other', label: 'Other', displayName: 'Other', enabledByDefault: true }],
});
/** Declares a rule action and no provider. */
const digest = definePlugin({
  manifest: { id: 'digest', name: 'Digest', version: '1', description: '' },
  rules: { actions: [defineRuleAction({ label: 'Digest', hint: '', validate() {}, ...AFTER_MESSAGE, type: 'digest.summarize', create: () => null })] },
});
const DECLARED = providerDeclarations([probe, other]);
const PROBE_WINDOW = { id: 'w', label: '5h', usedPercent: 42, resetsAt: null, durationMs: null };

/** A provider answering with the model it was made for. */
function answering(id: string, model: string | null): LlmProvider {
  return {
    id,
    maxInputChars: 1,
    complete: async (req) => ({ text: `${id}:${req.model ?? model ?? 'default'}` }),
    listModels: async () => [{ id: 'm', label: 'M' }],
    planUsage: async () => [PROBE_WINDOW],
  };
}
const impl = (id: string, status: ProviderImpl['status'] = async () => ({ available: true, detail: `${id} ready`, models: [] })): ProviderImpl => ({
  create: (choice) => answering(id, choice.model),
  status,
});

/** Probe and Other over a profile whose AI settings are `stored`. */
function start(stored: unknown, probeStatus?: ProviderImpl['status'], extra: readonly CorePlugin[] = []) {
  const db = tempDb();
  setSetting(db, 'ai', stored);
  return startProviders(
    [
      defineCorePlugin(probe, (ctx) => {
        ctx.ai.registerProvider('probe', impl('probe', probeStatus));
        ctx.ai.registerProvider('probe.local', impl('probe.local'));
      }),
      defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', impl('other'))),
      ...extra,
    ],
    [probe, other],
    db,
  );
}

describe('provider declarations', () => {
  const plugin = (id: string, providers: PluginDescriptor['providers']): PluginDescriptor => ({ manifest: { id, name: id, version: '1', description: '' }, providers });
  const decl = (id: string) => ({ id, label: id, displayName: id, enabledByDefault: false });
  it("take the plugin's id or <plugin id>.<name>, once per build", () => {
    expect(() => checkBundled([plugin('one', [decl('one'), decl('one.two')])])).not.toThrow();
    expect(() => checkBundled([plugin('one', [decl('two')])])).toThrow(/must be one or one\.<name>/);
    expect(() => checkBundled([plugin('one', [decl('one.2x')])])).toThrow(/must be one/);
    expect(() => checkBundled([plugin('one', [decl('one'), decl('one')])])).toThrow(/Two bundled plugins provide AI provider one/);
  });

  it('refuse a registration the plugin does not declare; the plugin fails to start and others run', () => {
    const rogue = definePlugin({ manifest: { id: 'rogue', name: 'Rogue', version: '1', description: '' } });
    const { host, registry } = start({}, undefined, [defineCorePlugin(rogue, (ctx) => ctx.ai.registerProvider('probe' as never, impl('rogue')))]);
    expect(host.list().find((p) => p.id === 'rogue')).toMatchObject({ status: 'error', error: 'rogue registers AI provider probe but declares none' });
    expect(registry.runs('probe')).toBe(true);
  });
});

describe('registered providers', () => {
  it('take requests by id with their stored choice', async () => {
    const { registry, ai } = start({ providers: { probe: { enabled: true, model: 'big' } } });
    expect(await registry.get('probe', ai()).complete({ system: '', prompt: '' })).toEqual({ text: 'probe:big' });
    expect(await registry.planUsage('probe', ai())).toEqual([PROBE_WINDOW]);
  });

  it('report their Settings → AI state in declared order; a throwing report shows its message and marks the plugin', async () => {
    const { host, registry, ai } = start({}, async () => {
      throw new Error('probe CLI crashed');
    });
    const status = await registry.status(ai());
    expect(status.map((s) => s.id)).toEqual(['probe', 'probe.local', 'other']);
    expect(status[0]).toEqual({ id: 'probe', available: false, detail: 'probe CLI crashed', models: null });
    expect(host.list().find((p) => p.id === 'probe')?.error).toBe('probe CLI crashed');
  });

  it("say which is local, and describe every declared provider with why it can't run", () => {
    const { registry } = start({});
    expect(registry.isLocal('probe.local')).toBe(true);
    expect(registry.isLocal('probe')).toBe(false);
    expect(registry.providers().find((p) => p.id === 'other')).toMatchObject({ label: 'Other', unavailable: null });
  });
});

describe('a provider turned off in Settings → AI', () => {
  it("is unavailable to plugins' own picks, naming why, while its plugin runs; on again, it answers", async () => {
    let ai: CoreContext['ai'] | undefined;
    const picker = definePlugin({ manifest: { id: 'picker', name: 'Picker', version: '1', description: '' } });
    const { db, registry } = start({}, undefined, [defineCorePlugin(picker, (ctx) => void (ai = ctx.ai))]);
    // Probe · local is off by default (enabledByDefault: false); its plugin runs.
    expect(registry.unavailable('probe.local')).toBeNull();
    expect(ai!.unavailable('probe.local')).toBe(TURNED_OFF);
    expect(ai!.providers().find((p) => p.id === 'probe.local')?.unavailable).toBe(TURNED_OFF);
    expect(() => ai!.provider('probe.local')).toThrow(TURNED_OFF);
    expect(ai!.unavailable('probe')).toBeNull();
    setSetting(db, 'ai', { providers: { 'probe.local': { enabled: true } } });
    expect(ai!.unavailable('probe.local')).toBeNull();
    expect(await ai!.provider('probe.local').complete({ system: '', prompt: '', reads: [] })).toEqual({ text: 'probe.local:default' });
  });
});

describe("a provider's plugin turned off", () => {
  it('leaves choices and requests, naming why; on again restores it', async () => {
    const stored = { providers: { probe: { enabled: true }, other: { enabled: true } } };
    const { host, registry, ai } = start(stored);
    await host.setEnabled('probe', false);
    expect(() => registry.get('probe', ai())).toThrow('Needs the Probe plugin, which is off.');
    expect(registry.unavailable('probe')).toBe('Needs the Probe plugin, which is off.');
    expect((await registry.status(ai())).map((s) => s.id)).toEqual(['other']);
    await host.setEnabled('probe', true);
    expect(await registry.get('probe', ai()).complete({ system: '', prompt: '' })).toEqual({ text: 'probe:default' });
  });

  it('revokes providers handed out before: later calls reject naming why, and a running completion is aborted', async () => {
    let seen: AbortSignal | undefined;
    const slow: ProviderImpl = {
      create: () => ({
        ...answering('probe', null),
        complete: (req) => {
          seen = req.signal;
          return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
        },
      }),
      status: async () => ({ available: true, detail: '', models: [] }),
    };
    const db = tempDb();
    const probeCore = defineCorePlugin(probe, (ctx) => {
      ctx.ai.registerProvider('probe', slow);
      ctx.ai.registerProvider('probe.local', impl('probe.local'));
    });
    const { host, registry, ai } = startProviders([probeCore, defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', impl('other')))], [probe, other], db);
    const retained = registry.get('probe', ai());
    const running = retained.complete({ system: '', prompt: '' });
    await host.setEnabled('probe', false);
    expect(seen?.aborted).toBe(true);
    await expect(running).rejects.toThrow('Needs the Probe plugin, which is off.');
    await expect(retained.complete({ system: '', prompt: '' })).rejects.toThrow('Needs the Probe plugin, which is off.');
    await expect(retained.listModels()).rejects.toThrow('Needs the Probe plugin, which is off.');
  });

  it('with every provider off, the registry reports none and names why for each', async () => {
    const { host, registry, ai } = start({});
    await host.setEnabled('probe', false);
    await host.setEnabled('other', false);
    expect(await registry.status(ai())).toEqual([]);
    expect(() => registry.get('other', ai())).toThrow('Needs the Other plugin, which is off.');
  });

  it('absent from the build: its id is named, and its stored settings survive a save', () => {
    const registry = new ProviderRegistry(() => undefined, DECLARED);
    expect(registry.unavailable('gone')).toBe("Needs the gone plugin, which this ChattyPop doesn't include.");
    const saved = normalizeAiSettings({ providers: { gone: { enabled: true, model: 'x', effort: 'high', displayName: 'G' } } }, DECLARED);
    expect(normalizeAiSettings(JSON.parse(JSON.stringify(saved)), DECLARED)).toMatchObject({
      providers: { gone: { enabled: true, model: 'x', effort: 'high', displayName: 'G' } },
    });
  });
});

describe("a provider's plugin that failed to start", () => {
  const FAILED = 'Needs the Probe plugin, which failed to start (see Settings → Plugins): probe CLI missing';

  it('says so with its error wherever the reason shows, not that it is off', () => {
    const failing = defineCorePlugin(probe, () => {
      throw new Error('probe CLI missing');
    });
    const { host, registry, ai } = startProviders([failing, defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', impl('other')))], [probe, other]);
    expect(host.list().find((p) => p.id === 'probe')).toMatchObject({ status: 'error', error: 'probe CLI missing' });
    expect(registry.unavailable('probe')).toBe(FAILED);
    expect(registry.providers().find((p) => p.id === 'probe')?.unavailable).toBe(FAILED);
    expect(() => registry.get('probe', ai())).toThrow(FAILED);
  });

  it('turned off afterwards reads as off again', async () => {
    const failing = defineCorePlugin(probe, () => {
      throw new Error('probe CLI missing');
    });
    const { host, registry } = startProviders([failing, defineCorePlugin(other, () => undefined)], [probe, other]);
    await host.setEnabled('probe', false);
    expect(registry.unavailable('probe')).toBe('Needs the Probe plugin, which is off.');
  });

  it("explains its rule kinds the same way (a rule stopped by it names the failure)", async () => {
    // In the build, as a bundled plugin is: a reason names an absent plugin by id, a present one by name.
    const build = BUNDLED_PLUGINS as PluginDescriptor[];
    build.push(digest);
    onTestFinished(() => void build.splice(build.indexOf(digest), 1));
    const failing = defineCorePlugin(digest, () => {
      throw new Error('digest broke');
    });
    const { host, rules } = startProviders([failing], [digest]);
    expect(rules.unavailable('actions', 'digest.summarize')).toBe('Needs the Digest plugin, which failed to start (see Settings → Plugins): digest broke');
    await host.setEnabled('digest', false);
    expect(rules.unavailable('actions', 'digest.summarize')).toBe('Needs the Digest plugin, which is off.');
  });
});

describe('stored AI settings (adoption with values intact)', () => {
  /** Settings → AI as saved before providers were plugins: every built-in provider's entry. */
  const PRE_EXTRACTION = {
    defaultProvider: 'codex',
    ollamaUrl: 'http://10.0.0.5:11434',
    jevConnection: 'openrouter',
    providers: {
      claude: { enabled: true, model: 'opus', effort: 'high', displayName: 'Opus' },
      codex: { enabled: true, model: null, effort: null, displayName: null },
      ollama: { enabled: false, model: 'llama3', effort: 'on', displayName: null },
      openrouter: { enabled: true, model: 'anthropic/claude-sonnet-5', effort: null, displayName: 'OR' },
    },
  };

  it('keep every provider entry under the same ids; the old default is left to the features that adopt it', () => {
    const ai = normalizeAiSettings(PRE_EXTRACTION, DECLARED);
    expect(ai).not.toHaveProperty('defaultProvider');
    for (const [id, entry] of Object.entries(PRE_EXTRACTION.providers)) expect(ai.providers[id]).toEqual(entry);
  });

  it('fill declared providers a profile never set from their declaration', () => {
    const fresh = normalizeAiSettings({}, providerDeclarations([probe]));
    expect(fresh.providers['probe']).toEqual({ enabled: true, model: null, effort: null, displayName: null });
    expect(fresh.providers['probe.local']?.enabled).toBe(false);
  });
});
