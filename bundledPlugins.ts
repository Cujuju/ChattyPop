// Generates process-specific virtual modules for selected development plugins. Excluded plugins ship no code.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseAst, runnerImport, transformWithEsbuild, type Plugin } from 'vite';
import { INSTALLED_PAGE_SHELL } from './src/shared/installedBrowser';
import { HOST_MODULES, SHARED_HOST_MODULE, type Platform, type TierHostModuleId } from './src/shared/installedPlugins';

/** Comma-separated plugin ids a build includes. Unset: every plugin folder (pluginFolders); `none` (or empty): none. */
export const BUNDLED_PLUGINS_ENV = 'CHATTYPOP_PLUGINS';
/** Absolute plugin-repository folders joined by the OS path delimiter; consumed only by the development server. */
export const PLUGIN_DIRS_ENV = 'CHATTYPOP_PLUGIN_DIRS';
/** Selects no plugins. Windows shells unset empty environment variables; an unset selection includes all plugins. */
export const NO_PLUGINS = 'none';
const VIRTUAL_PREFIX = 'virtual:bundled-plugins/';
/** Process entry filenames; absent entries contribute no code. */
const ENTRIES: Readonly<Record<string, string>> = {
  shared: 'shared/index.ts',
  core: 'core/index.ts',
  main: 'main/index.ts',
  renderer: 'renderer/index.tsx',
};

/** Parses plugin folders from dirsEnv. Unset means none; relative or missing folders throw. */
export function pluginDirs(dirsEnv: string | undefined): string[] {
  const dirs = (dirsEnv ?? '').split(delimiter).map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) if (!isAbsolute(d) || !existsSync(d)) throw new Error(`${PLUGIN_DIRS_ENV} names ${d}, which isn't an absolute, existing folder.`);
  return dirs.map((d) => resolve(d));
}

/** Lists plugin folders by ID in folder order. Duplicate IDs and the reserved ID none throw. */
export function pluginFolders(dirs: readonly string[]): Map<string, string> {
  const folders = new Map<string, string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const at = join(dir, e.name);
      if (e.name === NO_PLUGINS) throw new Error(`${at} can't be a plugin: ${BUNDLED_PLUGINS_ENV}=${NO_PLUGINS} means no plugins.`);
      const other = folders.get(e.name);
      if (other) throw new Error(`Plugin ${e.name} is in two folders: ${other} and ${at}.`);
      folders.set(e.name, at);
    }
  }
  return folders;
}

/** Where a build's plugins come from: a PLUGIN_DIRS_ENV value and a BUNDLED_PLUGINS_ENV value. */
export interface PluginSource {
  dirs?: string;
  selection?: string;
}
/** No plugin folders: every build that ships, and the host's tests. */
export const NO_PLUGIN_SOURCE: PluginSource = {};
/** Reads plugin sources from the development process environment. */
export const devPluginSource = (): PluginSource => ({ dirs: process.env[PLUGIN_DIRS_ENV], selection: process.env[BUNDLED_PLUGINS_ENV] });

/** `source`'s plugin folders. */
const buildFolders = (source: PluginSource): Map<string, string> => pluginFolders(pluginDirs(source.dirs));

/** Returns selected plugin IDs in folder order; unknown IDs throw. */
export function selectedPlugins(folders: ReadonlyMap<string, string>, env: string | undefined): string[] {
  const all = [...folders.keys()];
  if (env === undefined) return all;
  if (env.trim() === NO_PLUGINS) return [];
  const wanted = env.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`${BUNDLED_PLUGINS_ENV} names no plugin folder: ${unknown.join(', ')} (have ${all.join(', ') || 'none'})`);
  return all.filter((id) => wanted.includes(id));
}

/** Import paths of `entry` (a process's file) in the plugin folders `ids` that have one. */
const entryFiles = (folders: ReadonlyMap<string, string>, ids: readonly string[], entry: string): string[] =>
  ids.map((p) => join(folders.get(p)!, entry).replaceAll('\\', '/')).filter(existsSync);

/** Generates a list of default imports bound to binding. */
const listOf = (files: readonly string[], binding: string): string =>
  [...files.map((f, i) => `import p${i} from ${JSON.stringify(f)};`), `${binding} [${files.map((_, i) => `p${i}`).join(', ')}];`].join('\n');

/** Each plugins folder's catalog, built once per process however many environments load the shared registry. */
const catalogs = new Map<string, Promise<unknown>>();
const CATALOG_ENTRY = 'virtual:bundled-plugins-catalog';

/** Complete plugin anchor catalog for subset builds. Registry inclusion validates each plugin’s anchors. */
function catalogOf(root: string, folders: ReadonlyMap<string, string>): Promise<unknown> {
  const key = [...folders.values()].join(delimiter);
  const known = catalogs.get(key);
  if (known) return known;
  const types = resolve(root, 'src/shared/bundledCheck.ts').replaceAll('\\', '/');
  const code = [
    listOf(entryFiles(folders, [...folders.keys()], ENTRIES['shared']!), 'const all ='),
    `import { anchorCatalog } from ${JSON.stringify(types)};`,
    'export default anchorCatalog(all);',
  ].join('\n');
  const catalog = runnerImport<{ default: unknown }>(CATALOG_ENTRY, {
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: { alias: { '@shared': resolve(root, 'src/shared'), '@plugin-sdk': resolve(root, 'src/plugin-sdk') } },
    plugins: [{
      name: 'chattypop-bundled-plugins-catalog',
      resolveId: (id) => (id === CATALOG_ENTRY || id.startsWith(VIRTUAL_PREFIX) ? `\0${id}` : undefined),
      // Descriptor imports resolve host modules with no plugins included.
      load: (id) => (id === `\0${CATALOG_ENTRY}` ? code : id.startsWith(`\0${VIRTUAL_PREFIX}`) ? 'export default []; export const catalog = null;' : undefined),
    }],
  }).then((r) => r.module.default);
  catalogs.set(key, catalog);
  return catalog;
}

/** Installed plugins' registries (docs/plugin-architecture.md §16): the accepted descriptors, and host modules' export names. */
const INSTALLED_PREFIX = 'virtual:installed-plugins/';
const INSTALLED_SHARED = `${INSTALLED_PREFIX}shared`;
const HOST_EXPORTS = `${INSTALLED_PREFIX}host-exports`;
/** Node code that loads installed plugins' modules, as generated registries import it. */
const INSTALLED_RUNTIME = 'src/main/plugins/installed/runtime.ts';
/** Reads node-tier exports from source so installed-plugin import validation runs before loading the plugin registry. */
const STATIC_HOST_MODULES = HOST_MODULES.node.filter((id) => id !== SHARED_HOST_MODULE);
/** Complete node-tier publication registry; missing tiers fail type checking. */
const NODE_TIER_PUBLISHERS = { '@plugin-sdk/core': 'core', '@plugin-sdk/main': 'main' } as const satisfies Record<TierHostModuleId<'node'>, 'core' | 'main'>;

/** Generates namespace imports and host-module publication arguments. */
const publishing = (ids: readonly string[]): { imports: string[]; modules: string } => ({
  imports: ids.map((id, i) => `import * as host${i} from ${JSON.stringify(id)};`),
  modules: `{ ${ids.map((id, i) => `${JSON.stringify(id)}: host${i}`).join(', ')} }`,
});

const importPath = (root: string, file: string): string => JSON.stringify(resolve(root, file).replaceAll('\\', '/'));
/** A host module's source: `@plugin-sdk/<tier>` is src/plugin-sdk/<tier>/index.ts. */
const hostModuleFile = (root: string, id: string): string => resolve(root, 'src', id.slice(1), 'index.ts');

/** Node: the accepted plugins' descriptors, loaded once the shared SDK they read is published. */
const nodeInstalledShared = (root: string): string => {
  const { imports, modules } = publishing([SHARED_HOST_MODULE]);
  return [
    ...imports,
    "import build, { catalog } from 'virtual:bundled-plugins/shared';",
    `import { installedDescriptors } from ${importPath(root, INSTALLED_RUNTIME)};`,
    `export default installedDescriptors(${modules}, build, catalog);`,
  ].join('\n');
};

/** Browser loaders for installed plugins (docs/plugin-architecture.md §16): windows and the phone page await them. */
const BROWSER_SHARED_LOADER = 'src/renderer/src/plugins/installedShared.ts';
const BROWSER_RENDERER_LOADER = 'src/renderer/src/plugins/installedRenderers.ts';

/** Browser: the accepted plugins' descriptors, awaited (top-level await) before the shared registry's readers run. */
const browserInstalledShared = (root: string): string =>
  [
    "import build, { catalog } from 'virtual:bundled-plugins/shared';",
    `import { installedDescriptors } from ${importPath(root, BROWSER_SHARED_LOADER)};`,
    'export default await installedDescriptors(build, catalog);',
  ].join('\n');

/** Browser: the renderer registry: the build's entries, then the installed plugins' renderer sides, awaited. */
const browserRendererRegistry = (root: string, files: readonly string[]): string =>
  [
    listOf(files, 'const build ='),
    `import { installedRenderers } from ${importPath(root, BROWSER_RENDERER_LOADER)};`,
    'export default [...build, ...(await installedRenderers())];',
  ].join('\n');

/** Publishes SDK tiers before bundled and accepted installed-plugin node entries. */
const nodeSideRegistry = (root: string, files: readonly string[], side: 'core' | 'main'): string => {
  const tiers = STATIC_HOST_MODULES.filter((id) => NODE_TIER_PUBLISHERS[id] === side);
  const { imports, modules } = publishing([SHARED_HOST_MODULE, ...tiers]);
  return [
    listOf(files, 'const build ='),
    ...imports,
    // Descriptors first: a plugin whose descriptor fails here has its sides left out.
    `import ${JSON.stringify(INSTALLED_SHARED)};`,
    `import { installedSides } from ${importPath(root, INSTALLED_RUNTIME)};`,
    `const installed = installedSides(${JSON.stringify(side)}, ${modules});`,
    'export default [...build, ...installed.entries];',
    'export const failed = installed.failed;',
  ].join('\n');
};

type AstNode = { type: string; name?: string; value?: unknown; id?: AstNode | null; exported?: AstNode | null; declaration?: AstNode | null; declarations?: AstNode[]; specifiers?: AstNode[] };
const exportedName = (n: AstNode): string => (n.type === 'Identifier' ? n.name! : String(n.value));

/** Lists runtime TypeScript exports. Erases types and rejects export *. */
async function exportNames(file: string): Promise<string[]> {
  const { code } = await transformWithEsbuild(readFileSync(file, 'utf8'), file, { loader: 'ts' });
  return (parseAst(code).body as AstNode[]).flatMap((node): string[] => {
    if (node.type === 'ExportDefaultDeclaration') return ['default'];
    if (node.type === 'ExportAllDeclaration') {
      if (node.exported) return [exportedName(node.exported)];
      throw new Error(`${file}: export * hides names from installed plugins' import check; name them.`);
    }
    if (node.type !== 'ExportNamedDeclaration') return [];
    const d = node.declaration;
    if (!d) return node.specifiers!.map((s) => exportedName(s.exported!));
    if (d.type !== 'VariableDeclaration') return d.id ? [d.id.name!] : [];
    return d.declarations!.map((v) => {
      if (v.id?.type !== 'Identifier') throw new Error(`${file}: a destructured export hides its names from the import check.`);
      return v.id.name!;
    });
  });
}

/** Node: STATIC_HOST_MODULES' export names, by module id. */
async function hostExportsModule(root: string): Promise<string> {
  const names = Object.fromEntries(await Promise.all(STATIC_HOST_MODULES.map(async (id) => [id, await exportNames(hostModuleFile(root, id))] as const)));
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(names))});`;
}

/** Generates process-specific bundled-plugin entries. Shared catalog includes omitted plugins’ anchors; node registries append accepted installed plugins. */
export function bundledPlugins(root: string, platform: Platform, source: PluginSource): Plugin {
  const folders = buildFolders(source);
  const ids = selectedPlugins(folders, source.selection);
  const partial = ids.length < folders.size;
  return {
    name: 'chattypop-bundled-plugins',
    resolveId: (id) => (id.startsWith(VIRTUAL_PREFIX) || id.startsWith(INSTALLED_PREFIX) ? `\0${id}` : undefined),
    load(id) {
      if (id === `\0${INSTALLED_SHARED}`) return platform === 'node' ? nodeInstalledShared(root) : browserInstalledShared(root);
      if (id === `\0${HOST_EXPORTS}`) {
        STATIC_HOST_MODULES.forEach((m) => this.addWatchFile(hostModuleFile(root, m)));
        return hostExportsModule(root);
      }
      if (!id.startsWith(`\0${VIRTUAL_PREFIX}`)) return undefined;
      const process = id.slice(VIRTUAL_PREFIX.length + 1);
      const entry = ENTRIES[process];
      if (!entry) throw new Error(`No bundled-plugin entry for ${process}`);
      const files = entryFiles(folders, ids, entry);
      if (platform === 'node' && (process === 'core' || process === 'main')) return nodeSideRegistry(root, files, process);
      if (platform === 'browser' && process === 'renderer') return browserRendererRegistry(root, files);
      const registry = listOf(files, 'export default');
      if (process !== 'shared') return registry;
      if (!partial) return `${registry}\nexport const catalog = null;`;
      // JSON parsing preserves __proto__ as a key rather than an object-literal prototype setter.
      return catalogOf(root, folders).then((catalog) => `${registry}\nexport const catalog = JSON.parse(${JSON.stringify(JSON.stringify(catalog))});`);
    },
  };
}

/** Plugin HTML, relative script entries, and public page files. */
const PAGE_HTML = 'page/index.html';
/** Static page files copied to the renderer output root. */
const PAGE_PUBLIC_DIR = 'public';
/** Development content types for public page files. */
const DEV_MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** `source`'s selected plugins' pages: plugin id → its page folder. */
function selectedPages(source: PluginSource): Map<string, string> {
  const folders = buildFolders(source);
  return new Map(
    selectedPlugins(folders, source.selection)
      .filter((id) => existsSync(join(folders.get(id)!, PAGE_HTML)))
      .map((id) => [id, join(folders.get(id)!, dirname(PAGE_HTML))]),
  );
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name],
  );
}

/** The installed-page shell's build input name: its file name without `.html`. */
const SHELL_INPUT = basename(INSTALLED_PAGE_SHELL, extname(INSTALLED_PAGE_SHELL));

/** Selected plugin pages build as <id>.html. Excluded plugins have no page; the installed-page shell always builds. */
export function pageInputs(rendererRoot: string, source: PluginSource): Record<string, string> {
  const ids = [...selectedPages(source).keys()];
  if (ids.includes(SHELL_INPUT)) throw new Error(`Plugin ${SHELL_INPUT}'s page would replace the host's ${INSTALLED_PAGE_SHELL}.`);
  return Object.fromEntries([...ids, SHELL_INPUT].map((id) => [id, join(rendererRoot, `${id}.html`)]));
}

/** Renderer-root bootstrap loads theme and registry before page entries. */
export const PAGE_BOOTSTRAP = '/src/plugins/page.ts';
/** Installed-page bootstrap loads the shared bootstrap, then the named entry. */
export const INSTALLED_PAGE_BOOTSTRAP = '/src/plugins/installedPage.ts';
/** Installed-page shell head inserted into served plugin pages. */
const SHELL_HTML = `<!doctype html>
<html>
  <head>
    <script type="module" src="${INSTALLED_PAGE_BOOTSTRAP}"></script>
  </head>
  <body></body>
</html>
`;
/** A page's first module script, where the host's bootstrap goes in front of it. */
const FIRST_MODULE_SCRIPT = /<script type="module"/;

/** Prepends host bootstrap as the first module script. */
function withBootstrap(html: string): string {
  if (!FIRST_MODULE_SCRIPT.test(html)) throw new Error('A plugin page needs a module script entry.');
  return html.replace(FIRST_MODULE_SCRIPT, `<script type="module" src="${PAGE_BOOTSTRAP}"></script>\n    $&`);
}

/** Plugin pages load host bootstrap before their entry. Relative scripts resolve within page/; page/public files serve in development and copy to the output root. */
export function pagesPlugin(rendererRoot: string, source: PluginSource): Plugin {
  const pages = selectedPages(source);
  const htmlId = (id: string): string => join(rendererRoot, `${id}.html`).replaceAll(sep, '/');
  const shellId = htmlId(SHELL_INPUT);
  const pageOf = (file: string | undefined): string | undefined => [...pages].find(([id]) => file?.replaceAll(sep, '/') === htmlId(id))?.[1];
  const publicFile = (urlPath: string): string | null => {
    for (const dir of pages.values()) {
      const base = join(dir, PAGE_PUBLIC_DIR);
      const file = resolve(base, `.${decodeURIComponent(urlPath)}`);
      if (file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
  };
  return {
    name: 'chattypop-plugin-pages',
    resolveId(source, importer) {
      if (pageOf(source) || source.replaceAll(sep, '/') === shellId) return source;
      const dir = pageOf(importer);
      return dir && source.startsWith('.') ? resolve(dir, source) : undefined;
    },
    load(id) {
      if (id.replaceAll(sep, '/') === shellId) return SHELL_HTML;
      const dir = pageOf(id);
      return dir ? withBootstrap(readFileSync(join(dir, basename(PAGE_HTML)), 'utf8')) : undefined;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]!;
        if (path === `/${INSTALLED_PAGE_SHELL}`) {
          void server.transformIndexHtml(path, SHELL_HTML).then((out) => res.setHeader('content-type', 'text/html').end(out), next);
          return;
        }
        const page = [...pages].find(([id]) => path === `/${id}.html`);
        if (page) {
          // Rewrites relative script URLs to plugin files.
          const html = withBootstrap(readFileSync(join(page[1], basename(PAGE_HTML)), 'utf8')).replace(/src="\.\/([^"]+)"/g, (_m, file: string) => `src="/@fs/${join(page[1], file).replaceAll(sep, '/')}"`);
          void server.transformIndexHtml(path, html).then((out) => res.setHeader('content-type', 'text/html').end(out), next);
          return;
        }
        const file = publicFile(path);
        if (!file) return next();
        res.setHeader('content-type', DEV_MIME[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of pages.values()) {
        const base = join(dir, PAGE_PUBLIC_DIR);
        for (const file of filesUnder(base)) this.emitFile({ type: 'asset', fileName: file, source: readFileSync(join(base, file)) });
      }
    },
  };
}
