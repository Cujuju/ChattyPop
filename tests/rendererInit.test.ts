// SDK initialization precedes plugins across entry orders; host slots become available after registry installation.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_BOOTSTRAP } from '../bundledPlugins';
import { PLUGINS_DIR, ROOT, evaluate, importsOf, pluginRenderers } from './rendererGraph';

const SDK_DIR = join(ROOT, 'src/plugin-sdk/renderer');
const TIERS = [join(SDK_DIR, 'index.ts'), join(SDK_DIR, 'kit/index.ts'), join(SDK_DIR, 'shell/index.ts')];
const REGISTRY = join(ROOT, 'src/renderer/src/plugins/bundled.ts');
const inSdk = (file: string): boolean => file.startsWith(SDK_DIR);
const inPlugin = (file: string): boolean => file.startsWith(PLUGINS_DIR);
const rel = (file: string): string => file.slice(ROOT.length + 1).replaceAll('\\', '/');

/** A plugin page's module scripts in load order: the host bootstrap pagesPlugin puts first, then the page's entry. */
function pageScripts(): string[] {
  const html = join(PLUGINS_DIR, 'p2phone/page/index.html');
  const entry = /<script type="module" src="([^"]+)"/.exec(readFileSync(html, 'utf8'))![1]!;
  return [join(ROOT, 'src/renderer', PAGE_BOOTSTRAP), resolve(dirname(html), entry)];
}

/** Entry orders a window may load: the app's page, the phone's, and the SDK before the registry or after it. */
const ORDERS: Record<string, string[]> = {
  'the app page (main.tsx)': [join(ROOT, 'src/renderer/src/main.tsx')],
  'the phone page (bootstrap, then its entry)': pageScripts(),
  'the SDK first, then the registry': [...TIERS, REGISTRY],
  'the registry first, then the SDK': [REGISTRY, ...TIERS],
  'one plugin alone, before anything else': [pluginRenderers()[0]!, REGISTRY],
};

describe('renderer initialization', () => {
  it.each(Object.entries(ORDERS))('%s: no module reaches an SDK module still initializing', (_order, entries) => {
    const { backEdges } = evaluate(entries);
    expect(backEdges.filter((e) => inSdk(e.to)).map((e) => `${rel(e.from)} → ${rel(e.to)}`)).toEqual([]);
  });

  it.each(Object.entries(ORDERS))('%s: every SDK module a plugin loads has finished before that plugin runs', (_order, entries) => {
    const { steps } = evaluate(entries);
    const finished = new Set<string>();
    const early: string[] = [];
    for (const step of steps) {
      if (step.kind === 'finish') {
        finished.add(step.file);
        if (inPlugin(step.file)) {
          const sdk = importsOf(step.file).filter(inSdk);
          early.push(...sdk.filter((f) => !finished.has(f)).map((f) => `${rel(step.file)} ran before ${rel(f)}`));
        }
      }
    }
    expect(early).toEqual([]);
  });
});

describe('the plugin registry', () => {
  it('installs the renderer plugins once; a slot read before then fails loudly', async () => {
    // A renderer module: imported by path so the node type-check doesn't follow it.
    const installedPath = '../src/renderer/src/plugins/installed';
    const { installRendererPlugins, rendererPlugins, rendererPluginsInstalled } = (await import(installedPath)) as {
      installRendererPlugins(entries: readonly unknown[]): void;
      rendererPlugins(): readonly unknown[];
      rendererPluginsInstalled(): Promise<void>;
    };
    expect(() => rendererPlugins()).toThrow(/before the plugin registry installed/);
    // A plugin page renders once the registry installs (startPage), however long installed plugins take (§16).
    let installed = false;
    void rendererPluginsInstalled().then(() => (installed = true));
    const plugin = { manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, slots: { topBar: [{ id: 'bell' }] } };
    // A declared slot item without its view, or a view nothing declares, is refused before anything installs.
    expect(() => installRendererPlugins([{ plugin, contributions: {} }])).toThrow(/declares topBar bell/);
    expect(() => installRendererPlugins([{ plugin, contributions: { topBar: { bell: {}, extra: {} } } }])).toThrow(/renders topBar extra/);
    expect(() => rendererPlugins()).toThrow(/before the plugin registry installed/);
    const entries = [{ plugin, contributions: { topBar: { bell: {} } } }];
    await Promise.resolve();
    expect(installed).toBe(false);
    installRendererPlugins(entries);
    expect(rendererPlugins()).toBe(entries);
    await rendererPluginsInstalled();
    expect(installed).toBe(true);
    expect(() => installRendererPlugins([])).toThrow(/already installed/);
  });
});
