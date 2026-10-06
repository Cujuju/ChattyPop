// Per-file plugin source rules; violations use file:line: message.
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import { pluginTablePrefix } from '../../src/shared/bundledTypes';
import { HOST_MODULES } from '../../src/shared/installedPlugins';
import { lineAt, violation, type SourceFile } from './source';
import { lineOf, literalString, propertyName, readsVariable, syntaxOf, walk, type Node } from './syntax';

/** Only page files can import page code. */
export const PAGE_DIR = 'page';
/** The renderer tier that installs a page's API: only the phone transport's plugin imports it. */
export const SHELL_TIER = '@plugin-sdk/renderer/shell';
/** The SDK entries and host packages the host provides a plugin, on either platform. */
const HOST_PROVIDED: ReadonlySet<string> = new Set([...HOST_MODULES.node, ...HOST_MODULES.browser]);
/** Packages the host provides some modules of: any other module of theirs is no entry. */
const HOST_PACKAGES = ['@plugin-sdk', 'solid-js'];
const inHostPackage = (spec: string): boolean => HOST_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
/** Node's network modules: plugins reach the network through `ctx.net`. */
const NETWORK_MODULE = /^(?:node:)?(?:https?|net|tls|dgram)$/;
/** Test code uses host aliases and stays outside plugin builds. */
export const TESTS_DIR = 'tests';
/** A test file anywhere in the folder, with any script extension. */
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Source imports cannot reach skipped test files. */
const isTestPath = (rel: string): boolean => rel.split('/')[0] === TESTS_DIR || /\.test(?:\.[cm]?[jt]sx?)?$/.test(rel);

/** A specifier's package name: `@scope/name` or `name`. */
const packageName = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

/** One import of a file: its specifier (null when computed) and line. Type-only ones count. */
export interface Import {
  spec: string | null;
  line: number;
}

/** Nodes that load a module, with where their specifier sits. */
const IMPORTING: Readonly<Record<string, string>> = {
  ImportDeclaration: 'source',
  ExportNamedDeclaration: 'source',
  ExportAllDeclaration: 'source',
  ImportExpression: 'source',
  TSImportType: 'argument',
};

/** Every module `file` loads: import and export statements, `import()` (a type's too) and `require()`. */
export function importsOf(file: SourceFile): Import[] {
  const found: Import[] = [];
  walk(syntaxOf(file), (node) => {
    const at = IMPORTING[node.type];
    // `export { a }` names no module; `import()` parses as a call of `Import` too.
    if (at && node[at]) found.push({ spec: literalString(node[at]), line: lineOf(node) });
    if (node.type !== 'CallExpression') return;
    const callee = node['callee'] as Node;
    if (callee.type === 'Import' || (callee.type === 'Identifier' && callee['name'] === 'require'))
      found.push({ spec: literalString((node['arguments'] as Node[])[0]), line: lineOf(node) });
  });
  return found.sort((x, y) => x.line - y.line);
}

/** Allows SDK tiers, Solid, permitted Node built-ins, declared dependencies, and local files. Only page/ can import page/; network built-ins are excluded. */
export function importViolations(file: SourceFile, dependencies: ReadonlySet<string>): string[] {
  const inPage = (rel: string): boolean => rel.split('/')[0] === PAGE_DIR;
  return importsOf(file).flatMap(({ spec, line }) => {
    if (spec === null) return [violation(file.rel, line, 'a computed import: name the module')];
    const at = (message: string): string[] => [violation(file.rel, line, `${spec}: ${message}`)];
    if (spec.startsWith('.')) {
      const target = posix.join(posix.dirname(file.rel), spec.split('?')[0]!);
      if (target.startsWith('..')) return at('outside the plugin folder');
      if (isTestPath(target)) return at("test code, which the scan skips: source can't import it");
      return inPage(target) && !inPage(file.rel) ? at(`only the plugin's ${PAGE_DIR}/ may import its page`) : [];
    }
    if (NETWORK_MODULE.test(spec)) return at('a Node network module: reach the network through ctx.net');
    if (inHostPackage(spec)) return HOST_PROVIDED.has(spec) ? [] : at('not an entry the host provides');
    if (isBuiltin(spec) || dependencies.has(packageName(spec))) return [];
    return at("not the Plugin SDK, a Node built-in, a package.json dependency or the plugin's own file");
  });
}

/** Tables are named through `pluginTable` / `ctx.storage`, never by their physical prefix. */
export function tablePrefixViolations(file: SourceFile, pluginId: string): string[] {
  const prefix = pluginTablePrefix(pluginId);
  return [...file.text.matchAll(new RegExp(prefix, 'g'))].map((m) => violation(file.rel, lineAt(file.text, m.index), `literal table prefix ${prefix}: name tables with pluginTable or ctx.storage`));
}

/** Global identifiers bypassing plugin network or application contexts. */
const GLOBAL_NAMES: ReadonlySet<string> = new Set(['fetch', 'globalThis', 'createRequire']);
/** Web connections a plugin opens only through its contexts. */
const CONNECTIONS: ReadonlySet<string> = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource']);
/** Objects the global `fetch` is also a property of. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['window', 'self']);

/** What `node` reaches around the plugin's contexts, as the violation names it; null when nothing. */
function reachedGlobal(node: Node, parent: Node | null, key: string | null): string | null {
  if (node.type === 'Identifier') return GLOBAL_NAMES.has(node['name'] as string) && readsVariable(parent, key) ? (node['name'] as string) : null;
  if (node.type === 'NewExpression') {
    const callee = node['callee'] as Node;
    return callee.type === 'Identifier' && CONNECTIONS.has(callee['name'] as string) ? `new ${callee['name'] as string}` : null;
  }
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return null;
  const name = propertyName(node);
  const object = node['object'] as Node;
  if (name === 'fetch' && object.type === 'Identifier' && GLOBAL_OBJECTS.has(object['name'] as string)) return `${object['name'] as string}.fetch`;
  if (name === 'sendBeacon') return '.sendBeacon';
  if (name === 'chattypop') return node['computed'] ? "['chattypop']" : '.chattypop';
  return null;
}

/** Detects network and app access outside plugin contexts through syntax. Context methods, strings, and comments remain allowed. */
export function globalViolations(file: SourceFile): string[] {
  const found: string[] = [];
  walk(syntaxOf(file), (node, parent, key) => {
    const reached = reachedGlobal(node, parent, key);
    if (reached) found.push(violation(file.rel, lineOf(node), `${reached}: reach the network and the app through the plugin's contexts`));
  });
  return found;
}

/** Groups CSS declarations by property with source offsets. */
const declared = (body: string): Map<string, { value: string; index: number }> =>
  new Map([...body.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)].map((m) => [m[1]!, { value: m[2]!.trim(), index: m.index }]));

/** Requires matching -webkit-user-select beside user-select for Safari. */
export function userSelectViolations(file: SourceFile): string[] {
  return [...file.text.matchAll(/\{([^{}]*)\}/g)].flatMap((rule) => {
    const d = declared(rule[1]!);
    const plain = d.get('user-select');
    if (plain === undefined || d.get('-webkit-user-select')?.value === plain.value) return [];
    const line = lineAt(file.text, rule.index + 1 + plain.index);
    return [violation(file.rel, line, `user-select: ${plain.value} needs -webkit-user-select: ${plain.value} beside it`)];
  });
}
