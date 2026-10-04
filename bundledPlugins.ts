// Development plugins (the folders PLUGIN_DIRS_ENV names): which ones a build includes, served to each process as a
// virtual module. A plugin left out ships none of its code.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseAst, runnerImport, transformWithEsbuild, type Plugin } from 'vite';
import { INSTALLED_PAGE_SHELL } from './src/shared/installedBrowser';
import { HOST_MODULES, SHARED_HOST_MODULE, type Platform, type TierHostModuleId } from './src/shared/installedPlugins';

/** Comma-separated plugin ids a build includes. Unset: every plugin folder (pluginFolders); `none` (or empty): none. */
export const BUNDLED_PLUGINS_ENV = 'CHATTYPOP_PLUGINS';
/**
 * Absolute folders, joined by the OS path delimiter: local clones of the plugin repos' `plugins` folders, run by `pnpm
 * dev` with hot reload. Only the dev server reads it (devPluginSource).
 */
export const PLUGIN_DIRS_ENV = 'CHATTYPOP_PLUGIN_DIRS';
/** Selects no plugins. Spelled out because cmd.exe and Windows PowerShell 5 can't set a variable to empty (it unsets it: all). */
export const NO_PLUGINS = 'none';
const VIRTUAL_PREFIX = 'virtual:bundled-plugins/';
/** Each process's entry inside a plugin folder; a plugin without one has no part in that process. */
const ENTRIES: Readonly<Record<string, string>> = {
  shared: 'shared/index.ts',
  core: 'core/index.ts',
  main: 'main/index.ts',
  renderer: 'renderer/index.tsx',
};

/** The folders of plugin folders: each of `dirsEnv` (PLUGIN_DIRS_ENV), none when unset. Throws on a relative or missing one. */
export function pluginDirs(dirsEnv: string | undefined): string[] {
  const dirs = (dirsEnv ?? '').split(delimiter).map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) if (!isAbsolute(d) || !existsSync(d)) throw new Error(`${PLUGIN_DIRS_ENV} names ${d}, which isn't an absolute, existing folder.`);
  return dirs.map((d) => resolve(d));
}

/** Every plugin folder in `dirs`, by id, in folder order. Throws on an id two folders share, or one named `none`. */
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
/** The dev loop's plugins: this process's environment. Read only by `pnpm dev`, so a user-level variable never ships. */
export const devPluginSource = (): PluginSource => ({ dirs: process.env[PLUGIN_DIRS_ENV], selection: process.env[BUNDLED_PLUGINS_ENV] });

/** `source`'s plugin folders. */
const buildFolders = (source: PluginSource): Map<string, string> => pluginFolders(pluginDirs(source.dirs));

/** Plugin ids the build includes, in folder order. Throws on an id with no folder, so a typo can't ship a build without it. */
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

/** Module source importing `files`' default exports as a list bound to `binding` (an export or a declaration). */
const listOf = (files: readonly string[], binding: string): string =>
  [...files.map((f, i) => `import p${i} from ${JSON.stringify(f)};`), `${binding} [${files.map((_, i) => `p${i}`).join(', ')}];`].join('\n');

/** Each plugins folder's catalog, built once per process however many environments load the shared registry. */
const catalogs = new Map<string, Promise<unknown>>();
const CATALOG_ENTRY = 'virtual:bundled-plugins-catalog';

/**
 * Anchor catalog of every plugin folder (`anchorCatalog`), for a build that leaves plugins out: its anchors resolve
 * through it. A plugin's anchors are checked when a registry includes it.
 */
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
      // The host modules descriptors import see a build with no plugins; descriptors don't read the registry.
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
/**
 * Node host modules main's boot can't load before the plugin registry exists (their imports reach it), so it checks
 * installed plugins' imports of them against their export names, read from source here: every node tier.
 */
const STATIC_HOST_MODULES = HOST_MODULES.node.filter((id) => id !== SHARED_HOST_MODULE);
/** The node registry that publishes each tier module: complete, so a tier no process publishes is a type error. */
const NODE_TIER_PUBLISHERS = { '@plugin-sdk/core': 'core', '@plugin-sdk/main': 'main' } as const satisfies Record<TierHostModuleId<'node'>, 'core' | 'main'>;

/** Module source that publishes host modules `ids`: a namespace import of each, and the `{ id: namespace }` argument. */
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

/** Node: core's or main's registry: the build's entries, then the accepted plugins' sides, after publishing the SDK tiers they read. */
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

/** The names `file` (TypeScript) exports at run time: types are erased, and `export *` is refused, since its names aren't listed. */
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

/**
 * Resolves `virtual:bundled-plugins/<process>` to a module whose default export lists that process's entries. The
 * shared registry also exports `catalog`: every plugin folder's anchors when the build leaves some out, else null. On
 * `node`, core's and main's registries append the installed plugins main's start accepted (installedPlugins.ts).
 */
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
      // Parsed, not an object literal, where a `__proto__` key would set the prototype instead of naming an item.
      return catalogOf(root, folders).then((catalog) => `${registry}\nexport const catalog = JSON.parse(${JSON.stringify(JSON.stringify(catalog))});`);
    },
  };
}

/** A plugin's own page (docs/plugin-architecture.md §2): its HTML, whose scripts are relative to it, and public files. */
const PAGE_HTML = 'page/index.html';
/** Inside the page folder: files copied to the renderer output root (a service worker, install icons). */
const PAGE_PUBLIC_DIR = 'public';
/** Content types for public page files in development; the build copies them and the serving plugin types them. */
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

/**
 * Renderer build inputs for the selected plugins' pages: `<id>.html` at the renderer root, which exists only as this
 * plugin's module (pagesPlugin). A plugin left out of the build ships no page. The installed-page shell is always built.
 */
export function pageInputs(rendererRoot: string, source: PluginSource): Record<string, string> {
  const ids = [...selectedPages(source).keys()];
  if (ids.includes(SHELL_INPUT)) throw new Error(`Plugin ${SHELL_INPUT}'s page would replace the host's ${INSTALLED_PAGE_SHELL}.`);
  return Object.fromEntries([...ids, SHELL_INPUT].map((id) => [id, join(rendererRoot, `${id}.html`)]));
}

/** The host's page bootstrap (theme, then the plugin registry), from the renderer root; a page's entry runs after it. */
export const PAGE_BOOTSTRAP = '/src/plugins/page.ts';
/** The installed pages' bootstrap: the page bootstrap, then the entry main names in the page (docs/plugin-architecture.md §16). */
export const INSTALLED_PAGE_BOOTSTRAP = '/src/plugins/installedPage.ts';
/** The installed-page shell: only its head is used, which main puts into each installed page it serves. */
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

/** `html` with the host's bootstrap as its first module script, so the registry is installed before the page renders. */
function withBootstrap(html: string): string {
  if (!FIRST_MODULE_SCRIPT.test(html)) throw new Error('A plugin page needs a module script entry.');
  return html.replace(FIRST_MODULE_SCRIPT, `<script type="module" src="${PAGE_BOOTSTRAP}"></script>\n    $&`);
}

/**
 * Serves and builds plugin pages as if they sat at the renderer root: `<id>.html` loads the plugin's page/index.html,
 * with the host's bootstrap before its own entry; its relative scripts resolve inside the plugin's page folder, and
 * page/public files are served (dev) and copied (build) to the output root. Also the installed-page shell.
 */
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
          // The browser resolves relative scripts against the URL, not the plugin folder: point them at the files.
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
