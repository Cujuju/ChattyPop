// Host modules in an installed plugin's build (docs/plugin-architecture.md §16): each import of a HOST_MODULES id
// resolves to a generated shim that reads the host's namespace from globalThis[HOST_MODULES_KEY], so the plugin never
// bundles a second SDK or Solid runtime. The shim is a virtual module whose named exports are synthetic (rollup's
// syntheticNamedExports): every name reads the namespace, so its exports needn't be known before the importers are
// parsed. Externals would need a relative path per chunk, which rollup derives from the input folder (wrong when the
// output sits elsewhere, on another drive on Windows). The names each module imports are read from its AST.
import { isBuiltin } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import type { Plugin, Rollup } from 'vite';
import { HOST_MODULES, HOST_MODULES_KEY, type HostModuleId, type Platform } from '../../shared/installedPlugins';

const SHIM_PREFIX = '\0chattypop-host:';
/** The shim's export that its synthetic named exports read. */
const NAMESPACE = '__hostNamespace';
/** The host's own modules, which a plugin reaches only through the SDK. */
const HOST_INTERNAL = /^(?:@shared|@core|@main|@)(?:\/|$)|^electron(?:\/|$)/;
/** Packages the host provides some modules of: any other module of theirs would bundle a second copy. */
const HOST_PACKAGES = [...new Set([...HOST_MODULES.node, ...HOST_MODULES.browser].map((id) => id.split('/').slice(0, id.startsWith('@') ? 2 : 1).join('/')))];

const inside = (dir: string, file: string): boolean => {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The shim's source: the host's namespace for `id`, or an error naming it when the host didn't publish one. */
const shimSource = (id: string): string => {
  const key = `Symbol.for(${JSON.stringify(HOST_MODULES_KEY.description)})`;
  return [
    `const ns = globalThis[${key}]?.[${JSON.stringify(id)}];`,
    `if (!ns) throw new Error(${JSON.stringify(`ChattyPop didn't provide ${id} to this plugin.`)});`,
    `export const ${NAMESPACE} = ns;`,
  ].join('\n');
};

type Node = { type: string; [key: string]: unknown };
const nameOf = (n: Node): string => (n['type'] === 'Identifier' ? (n['name'] as string) : String(n['value']));

/**
 * The host-module build step for one platform. Resolves its host modules to shims and records the names imported from
 * each into `imports`. Refuses what an installed plugin can't import: host internals, the other platform's host modules
 * or other modules of a host package, namespace and dynamic imports of a host module, Node built-ins in a browser
 * build, and relative imports reaching out of the plugin folder.
 */
export function hostModulesPlugin(platform: Platform, pluginDir: string, imports: Map<HostModuleId, Set<string>>): Plugin {
  const provided: readonly string[] = HOST_MODULES[platform];
  const name = (file: string): string => relative(pluginDir, file.split('?')[0]!).replaceAll(sep, '/');
  const record = (from: string, id: HostModuleId, names: string[]): void => {
    if (names.includes('*')) throw new Error(`${from} imports all of ${id} (import * or export *): import the names it uses, so the host can check it provides them.`);
    const set = imports.get(id) ?? new Set<string>();
    for (const n of names) set.add(n);
    imports.set(id, set);
  };
  return {
    name: 'chattypop-installed-host-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const from = name(importer);
      if (HOST_INTERNAL.test(source)) throw new Error(`${from} imports ${source}, a host internal: an installed plugin imports only @plugin-sdk/*, its own folder and packages.`);
      if (provided.includes(source)) return { id: `${SHIM_PREFIX}${source}`, syntheticNamedExports: NAMESPACE, moduleSideEffects: false };
      if (HOST_PACKAGES.some((p) => source === p || source.startsWith(`${p}/`))) {
        const other = (Object.keys(HOST_MODULES) as Platform[]).find((p) => p !== platform && (HOST_MODULES[p] as readonly string[]).includes(source));
        throw new Error(other
          ? `${from} imports ${source}, which the host provides only to ${other} code; the ${platform} build (${platform === 'node' ? 'shared, core, main' : 'shared, renderer'}) can't use it.`
          : `${from} imports ${source}, which the host doesn't provide (it provides ${provided.join(', ')}).`);
      }
      if (isBuiltin(source)) {
        if (platform === 'browser') throw new Error(`${from} imports ${source}, a Node built-in, into browser code (shared or renderer).`);
        return { id: source.startsWith('node:') ? source : `node:${source}`, external: true };
      }
      if (!source.startsWith('.') || !inside(pluginDir, importer) || importer.split(/[\\/]/).includes('node_modules')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const file = resolved?.id.split('?')[0];
      if (file && isAbsolute(file) && !inside(pluginDir, file)) throw new Error(`${from} imports ${source}, outside the plugin folder.`);
      return resolved;
    },
    load: (id) => (id.startsWith(SHIM_PREFIX) ? shimSource(id.slice(SHIM_PREFIX.length)) : null),
    moduleParsed(info: Rollup.ModuleInfo) {
      if (info.id.startsWith(SHIM_PREFIX) || !info.ast) return;
      const from = name(info.id);
      const dynamic = info.dynamicallyImportedIds.find((id) => id.startsWith(SHIM_PREFIX));
      if (dynamic) throw new Error(`${from} imports ${dynamic.slice(SHIM_PREFIX.length)} dynamically: import it statically, by name.`);
      for (const node of info.ast.body as unknown as Node[]) {
        const source = (node['source'] as { value?: unknown } | null | undefined)?.value;
        if (typeof source !== 'string' || !provided.includes(source)) continue;
        const id = source as HostModuleId;
        if (node.type === 'ExportAllDeclaration') record(from, id, ['*']);
        const specifiers = (node['specifiers'] ?? []) as Node[];
        record(from, id, specifiers.map((s) =>
          s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : nameOf((s.type === 'ImportSpecifier' ? s['imported'] : s['local']) as Node)));
      }
    },
  };
}
