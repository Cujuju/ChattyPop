// Resolves runtime renderer imports through aliases for boundary and initialization tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
const ALIASES: Record<string, string> = {
  '@/': 'src/renderer/src/',
  '@plugin-sdk/': 'src/plugin-sdk/',
  '@shared/': 'src/shared/',
  // Node code's (main's boot graph); the renderer never imports them.
  '@core/': 'src/core/',
  '@main/': 'src/main/',
};
/** The renderer plugin registry's virtual module: every bundled plugin's renderer side, then the installed plugins' loader. */
export const RENDERER_REGISTRY = 'virtual:bundled-plugins/renderer';
/** The shared registry's virtual module in the browser: the build's descriptors (shared code), then the installed plugins' loader. */
const SHARED_REGISTRY = 'virtual:bundled-plugins/shared';
/** The installed-plugin loaders each browser registry imports after the build's entries (bundledPlugins.ts, docs/plugin-architecture.md §16). */
const INSTALLED_LOADERS = {
  shared: join(ROOT, 'src/renderer/src/plugins/installedShared.ts'),
  renderer: join(ROOT, 'src/renderer/src/plugins/installedRenderers.ts'),
};
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
/** Counts runtime imports and re-exports in source order. Erases type-only statements; mixed type imports still load modules under verbatimModuleSyntax. */
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gms;
/** A dynamic import that runs (not a type position such as `import('./x').Type`). */
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)(?!\s*\.\s*[A-Z])/g;

/** The plugin folders the registry's virtual module imports from in these tests: fixtures; the host's tests build none. */
export const PLUGINS_DIR = join(ROOT, 'tests/fixtures/p2Plugins');

/** Each plugin's renderer entry in `dir`: what the registry's virtual module imports. */
export const pluginRenderers = (dir = PLUGINS_DIR): string[] =>
  readdirSync(dir)
    .map((id) => join(dir, id, 'renderer/index.tsx'))
    .filter(existsSync);

/** Source files `spec` loads from `from`: the registry's plugins, or one file; none for packages, styles and other virtual modules. */
export function resolveImport(spec: string, from: string): string[] {
  if (spec === RENDERER_REGISTRY) return [...pluginRenderers(), INSTALLED_LOADERS.renderer];
  if (spec === SHARED_REGISTRY) return [INSTALLED_LOADERS.shared];
  const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a));
  const path = spec.split('?')[0]!;
  const base = alias ? join(ROOT, ALIASES[alias]!, path.slice(alias.length)) : path.startsWith('.') ? resolve(dirname(from), path) : null;
  if (base === null || /\.(css|svg|png|json)$/.test(base)) return [];
  // .mjs: plain-JS modules shared with scripts that run before any build (src/shared/splash.mjs).
  const file = [base, ...SOURCE_EXTENSIONS.map((e) => base + e)].find((f) => existsSync(f) && /\.(tsx?|mjs)$/.test(f));
  if (!file) throw new Error(`Cannot resolve ${spec} from ${from}`);
  return [resolve(file)];
}

const cache = new Map<string, string[]>();
/** The source files `file` loads, in the order it imports them. */
export function importsOf(file: string): string[] {
  let found = cache.get(file);
  if (!found) {
    const code = readFileSync(file, 'utf8');
    const specs = [...code.matchAll(STATIC_IMPORT), ...code.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]!);
    found = specs.flatMap((spec) => resolveImport(spec, file));
    cache.set(file, found);
  }
  return found;
}

/** Every source file `entries` load, directly or through others. */
export function closure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    importsOf(file).forEach(visit);
  };
  entries.forEach(visit);
  return seen;
}

/** One step of ES module evaluation: a module entered, or finished (its body ran). */
export interface EvaluationStep {
  kind: 'enter' | 'finish';
  file: string;
}
/** An import that reaches a module still being evaluated: the importer runs before it finishes (a cycle). */
export interface BackEdge {
  from: string;
  to: string;
}

/** ES module evaluation from `entries` in order: depth first, imports in source order, each module once. */
export function evaluate(entries: readonly string[]): { steps: EvaluationStep[]; backEdges: BackEdge[] } {
  const steps: EvaluationStep[] = [];
  const backEdges: BackEdge[] = [];
  const state = new Map<string, 'evaluating' | 'done'>();
  const visit = (file: string): void => {
    state.set(file, 'evaluating');
    steps.push({ kind: 'enter', file });
    for (const dep of importsOf(file)) {
      const s = state.get(dep);
      if (s === 'evaluating') backEdges.push({ from: file, to: dep });
      else if (s === undefined) visit(dep);
    }
    state.set(file, 'done');
    steps.push({ kind: 'finish', file });
  };
  for (const entry of entries) if (!state.has(entry)) visit(entry);
  return { steps, backEdges };
}
