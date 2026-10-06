// Builds plugin.json plus node/browser output for releases, source installs and local builds. Relative imports permit app and release-script use.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build, type InlineConfig, type Plugin, type Rollup } from 'vite';
import solid from 'vite-plugin-solid';
import {
  INSTALLED_FORMAT,
  INSTALLED_MANIFEST_FILE,
  INSTALLED_PLATFORM_DIRS,
  PLUGIN_SDK_VERSION,
  parseInstalledManifest,
  type HostModuleId,
  type InstalledManifest,
  type Platform,
} from '../../shared/installedPlugins';
import { declarations, lookCustomProperties, pluginViolation, where, type Declaration } from './cssRules';
import { SHARED_ENTRY, builtDescriptor, sourceDescriptor } from './descriptor';
import { hostModulesPlugin } from './hostModules';
import { PAGE_INPUT, reachableCss, readPage, writePage } from './page';

export interface BuildOptions {
  /** The plugin folder: shared/index.ts, and core/, main/, renderer/, page/ as it has them. */
  pluginDir: string;
  /** Where the build goes; absent or empty. */
  outDir: string;
  /** What plugin code's `__APP_VERSION__` reads: the version of the ChattyPop building it, fixed into the build. */
  appVersion: string;
  /**
   * ChattyPop checkout to validate against: descriptor evaluated from source and anchor-checked with `anchorFolders`;
   * theme look tokens join the style check. Without it, the start checks descriptor built into node/shared.js.
   */
  repoRoot?: string;
  /** With repoRoot: other plugin folders whose declarations its anchors may name (one holding its id is left out). */
  anchorFolders?: readonly string[];
}

/** Each side's entry in a plugin folder, and the platform builds it joins. */
const SIDES = { shared: 'shared/index.ts', core: 'core/index.ts', main: 'main/index.ts', renderer: 'renderer/index.tsx' } as const;
type Side = keyof typeof SIDES;
const PLATFORM_SIDES: Record<Platform, readonly Side[]> = { node: ['shared', 'core', 'main'], browser: ['shared', 'renderer'] };
/** The host's stylesheets, whose look declarations decide which custom properties a plugin may not set. */
const HOST_STYLES_DIR = 'src/renderer/src';

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : cssFiles(join(dir, e.name))) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);

/** Throws unless every stylesheet in the plugin folder holds structure only (§14). */
export function checkStyles(pluginDir: string, repoRoot: string | undefined): void {
  const read = (root: string, files: string[]): Declaration[] => files.flatMap((f) => declarations(relative(root, f).replaceAll('\\', '/'), readFileSync(f, 'utf8')));
  const own = read(pluginDir, cssFiles(pluginDir));
  const host = repoRoot ? read(repoRoot, cssFiles(resolve(repoRoot, HOST_STYLES_DIR))) : [];
  const lookTokens = lookCustomProperties([...host, ...own]);
  const bad = own.flatMap((d) => {
    const why = pluginViolation(d, lookTokens);
    return why ? [`${where(d)}: ${why}`] : [];
  });
  if (bad.length) throw new Error(`A plugin's CSS holds structure only, with tokens (docs/plugin-architecture.md §14):\n${bad.join('\n')}`);
}

/** Runs one platform's build into its folder (INSTALLED_PLATFORM_DIRS) in `outDir` and returns its output. */
async function buildPlatform(platform: Platform, pluginDir: string, outDir: string, input: Record<string, string>, appVersion: string, imports: Map<HostModuleId, Set<string>>): Promise<(Rollup.OutputChunk | Rollup.OutputAsset)[]> {
  const dir = join(outDir, INSTALLED_PLATFORM_DIRS[platform]);
  const plugins: Plugin[] = [hostModulesPlugin(platform, pluginDir, imports), ...(platform === 'browser' ? [solid({ ssr: false, dev: false, hot: false })] : [])];
  const config: InlineConfig = {
    configFile: false,
    envDir: false,
    publicDir: false,
    root: pluginDir,
    base: './',
    mode: 'production',
    logLevel: 'warn',
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    // Inline, so no PostCSS config file around the plugin folder is loaded.
    css: { postcss: {} },
    plugins,
    // Node: every package bundled; the host modules and node: built-ins stay imports (hostModulesPlugin).
    ...(platform === 'node' ? { ssr: { noExternal: true, target: 'node' as const } } : {}),
    build: {
      outDir: dir,
      emptyOutDir: true,
      ssr: platform === 'node',
      // Readable output; size doesn't matter for a plugin loaded from disk.
      minify: false,
      modulePreload: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      cssCodeSplit: true,
      rollupOptions: {
        input,
        // The loader reads each entry's exports: keep them exactly.
        preserveEntrySignatures: 'strict',
        output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
      },
    },
  };
  const result = await build(config);
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((o) => ('output' in o ? o.output : []));
}

/** Builds `pluginDir` into `outDir` and returns the plugin.json it wrote. Throws the reason a plugin can't be built. */
export async function buildInstalledPlugin({ pluginDir: dirIn, outDir: outIn, appVersion, repoRoot: rootIn, anchorFolders = [] }: BuildOptions): Promise<InstalledManifest> {
  const named = resolve(dirIn);
  if (!existsSync(join(named, SHARED_ENTRY))) throw new Error(`${named} is not a plugin folder: it has no ${SHARED_ENTRY}.`);
  // Canonical real paths ensure junctions, symlinks and 8.3 aliases cannot bypass outside-import checks.
  const pluginDir = realpathSync.native(named);
  const outDir = resolve(outIn);
  const repoRoot = rootIn === undefined ? undefined : resolve(rootIn);
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`The build folder ${outDir} must be empty.`);
  checkStyles(pluginDir, repoRoot);
  const source = repoRoot ? await sourceDescriptor(pluginDir, repoRoot, anchorFolders) : null;
  const page = readPage(pluginDir);

  const sides = (Object.keys(SIDES) as Side[]).filter((s) => existsSync(join(pluginDir, SIDES[s])));
  const hostImports = new Map<HostModuleId, Set<string>>();
  const entries: Partial<Record<Platform, Partial<Record<Side, string>>>> = {};
  let styles: string[] = [];
  let builtPage: InstalledManifest['browser']['page'];
  for (const platform of Object.keys(PLATFORM_SIDES) as Platform[]) {
    const own = sides.filter((s) => PLATFORM_SIDES[platform].includes(s));
    const input: Record<string, string> = Object.fromEntries(own.map((s) => [s, join(pluginDir, SIDES[s])]));
    // The page's entry builds with the browser sides, sharing their chunks: one instance of each module on the phone.
    if (platform === 'browser' && page) input[PAGE_INPUT] = page.entry;
    const output = await buildPlatform(platform, pluginDir, outDir, input, appVersion, hostImports);
    // Marks node/*.js as ESM independent of ancestor package.json.
    const dir = INSTALLED_PLATFORM_DIRS[platform];
    if (platform === 'node') writeFileSync(join(outDir, dir, 'package.json'), `${JSON.stringify({ type: 'module' })}
`);
    entries[platform] = Object.fromEntries(own.map((s) => [s, `${dir}/${s}.js`]));
    if (platform !== 'browser') continue;
    // Windows get every stylesheet but those only the page imports; the page gets those its entry reaches.
    const pageCss = page ? reachableCss(output, [PAGE_INPUT]) : new Set<string>();
    const sideCss = reachableCss(output, own);
    const css = output.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => o.fileName);
    styles = css.filter((f) => !pageCss.has(f) || sideCss.has(f)).map((f) => `${dir}/${f}`).sort();
    if (page) builtPage = writePage(page, outDir, [...pageCss]);
  }

  const { manifest: m } = source ?? (await builtDescriptor(join(outDir, INSTALLED_PLATFORM_DIRS.node, 'shared.js')));
  const manifest = parseInstalledManifest({
    format: INSTALLED_FORMAT,
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    sdk: PLUGIN_SDK_VERSION,
    node: entries.node,
    browser: { ...entries.browser, styles, ...(builtPage ? { page: builtPage } : {}) },
    hostImports: Object.fromEntries([...hostImports].sort(([a], [b]) => a.localeCompare(b)).map(([id, names]) => [id, [...names].sort()])),
  });
  writeFileSync(join(outDir, INSTALLED_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
