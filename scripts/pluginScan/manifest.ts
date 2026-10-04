// A plugin's manifest id and version literal in its shared/index.ts, found through syntax: release stamping rewrites the
// version in place (scripts/pluginReleaseChanged.ts), and plugin:check's scan refuses a shape it can't stamp.
import type { SourceFile } from './source';
import { syntaxOf, walk, type Node } from './syntax';

/** The manifest's id and version, and where the version's string literal (quotes included) sits in the text. */
export interface ManifestVersion {
  id: string;
  version: string;
  start: number;
  end: number;
}

const fail = (why: string): never => {
  throw new Error(`the definePlugin manifest can't be stamped: ${why}`);
};

/** Type-only wrappers around an expression (`x as const`, `x satisfies T`, `<T>x`, `x!`). */
const TYPE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
const unwrap = (node: Node): Node => (TYPE_WRAPPERS.has(node.type) ? unwrap(node['expression'] as Node) : node);

/** A non-computed property's name (`a:` or `'a':`); null otherwise. */
function keyName(prop: Node): string | null {
  if (prop['computed']) return null;
  const key = prop['key'] as Node;
  return key.type === 'Identifier' ? (key['name'] as string) : key.type === 'StringLiteral' ? (key['value'] as string) : null;
}

/** The one property `name` of `object`; refuses spreads, which could set it unseen. */
function property(object: Node, name: string, where: string): Node {
  const props = object['properties'] as Node[];
  if (props.some((p) => p.type === 'SpreadElement')) fail(`${where} spreads another object`);
  const found = props.filter((p) => keyName(p) === name);
  if (found.length !== 1 || found[0]!.type !== 'ObjectProperty') fail(`${where} needs exactly one \`${name}\` property`);
  return found[0]!;
}

/** The object literal a top-level `const name = { ... }` holds; refuses an import or anything else. */
function constObject(program: Node, name: string): Node {
  const body = program['body'] as Node[];
  const imported = body.some((s) => s.type === 'ImportDeclaration' && (s['specifiers'] as Node[]).some((x) => (x['local'] as Node)['name'] === name));
  if (imported) fail(`\`${name}\` is imported; declare it in shared/index.ts`);
  const declarations = body
    .map((s) => (s.type === 'ExportNamedDeclaration' && s['declaration'] ? (s['declaration'] as Node) : s))
    .filter((s) => s.type === 'VariableDeclaration')
    .flatMap((s) => (s['declarations'] as Node[]).map((d) => ({ kind: s['kind'] as string, d })))
    .filter(({ d }) => (d['id'] as Node).type === 'Identifier' && (d['id'] as Node)['name'] === name);
  if (declarations.length !== 1) fail(`\`${name}\` must be one top-level const in shared/index.ts`);
  const { kind, d } = declarations[0]!;
  const init = d['init'] ? unwrap(d['init'] as Node) : null;
  if (kind !== 'const' || init?.type !== 'ObjectExpression') fail(`\`${name}\` must be a const object literal`);
  return init!;
}

/** A string property's literal node; refuses anything computed. */
function literal(manifest: Node, name: string): Node {
  const value = unwrap(property(manifest, name, 'the manifest')['value'] as Node);
  if (value.type !== 'StringLiteral') fail(`its \`${name}\` must be a string literal`);
  return value;
}

/** `file`'s (a plugin's shared/index.ts) manifest id and version; throws why it can't be stamped. */
export function manifestVersion(file: SourceFile): ManifestVersion {
  const program = syntaxOf(file);
  const calls: Node[] = [];
  walk(program, (node) => {
    const callee = node.type === 'CallExpression' ? (node['callee'] as Node) : null;
    if (callee?.type === 'Identifier' && callee['name'] === 'definePlugin') calls.push(node);
  });
  if (calls.length !== 1) fail(`found ${calls.length} definePlugin calls, not one`);
  const arg = (calls[0]!['arguments'] as Node[])[0];
  const options = arg ? unwrap(arg) : null;
  if (options?.type !== 'ObjectExpression') fail('definePlugin takes an object literal');
  const value = unwrap(property(options!, 'manifest', 'definePlugin')['value'] as Node);
  const manifest = value.type === 'Identifier' ? constObject(program, value['name'] as string) : value;
  if (manifest.type !== 'ObjectExpression') fail('its manifest must be an object literal or a const naming one');
  const id = literal(manifest, 'id');
  const version = literal(manifest, 'version');
  return { id: id['value'] as string, version: version['value'] as string, start: version['start'] as number, end: version['end'] as number };
}

/** `text` with the manifest version replaced by `version`, in the same quotes; every other byte kept. */
export function stampVersion(text: string, version: string, rel: string): string {
  const at = manifestVersion({ rel, text });
  const quote = text[at.start]!;
  return `${text.slice(0, at.start)}${quote}${version}${quote}${text.slice(at.end)}`;
}
