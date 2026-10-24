// Parses each file once with oxc-parser (oxlint's parser), distinguishing code from comments, strings, and regular expressions.
import { parseSync, type Program } from 'oxc-parser';
import { lineAt, type SourceFile } from './source';

/** An ESTree node, as far as the rules read it. Offsets are UTF-16. */
export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

const trees = new WeakMap<SourceFile, Node>();

/** `text`'s typed ESTree program, parsed by `rel`'s extension (JSX only in .jsx/.tsx); throws on a syntax error, naming its line. Every scan parses here. */
export function programOf(text: string, rel: string): Program {
  // Parentheses are not nodes in ESTree; oxc keeps them by default.
  const result = parseSync(rel, text, { sourceType: 'module', preserveParens: false });
  const error = result.errors[0];
  if (error) throw new SyntaxError(`${rel}:${lineAt(text, error.labels[0]?.start ?? 0)}: ${error.message}`);
  return result.program;
}

/** `text`'s program as the rules read it. */
export const parseProgram = (text: string, rel: string): Node => programOf(text, rel) as unknown as Node;

/** `file`'s program, parsed once. */
export function syntaxOf(file: SourceFile): Node {
  const known = trees.get(file);
  if (known) return known;
  const tree = parseProgram(file.text, file.rel);
  trees.set(file, tree);
  return tree;
}

/** Visits each node with its parent and containing property. */
export function walk(node: Node, visit: (node: Node, parent: Node | null, key: string | null) => void, parent: Node | null = null, key: string | null = null): void {
  visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) for (const item of v) isNode(item) && walk(item, visit, node, k);
    else if (isNode(v)) walk(v, visit, node, k);
  }
}

/** `node`'s 1-based line in `text`. */
export const lineOf = (text: string, node: Node): number => lineAt(text, node.start);

/** A string literal's value; null for any other node. */
export const stringLiteral = (node: unknown): string | null =>
  isNode(node) && node.type === 'Literal' && typeof node['value'] === 'string' ? node['value'] : null;

/** A plain `key: value` property; methods and accessors are Property nodes too in ESTree. */
export const isValueProperty = (node: Node): boolean => node.type === 'Property' && node['kind'] === 'init' && !node['method'];

/** A string literal's value, or a template literal's without substitutions; null for anything computed. */
export function literalString(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type !== 'TemplateLiteral') return stringLiteral(node);
  if ((node['expressions'] as unknown[]).length) return null;
  return ((node['quasis'] as { value: { cooked: string | null } }[])[0]?.value.cooked) ?? null;
}

/** A member's property name: `a.name` or `a['name']`; null when computed otherwise. */
export function propertyName(member: Node): string | null {
  const property = member['property'] as Node;
  if (!member['computed']) return property.type === 'Identifier' ? (property['name'] as string) : null;
  return literalString(property);
}

/** Keyed members, whose non-computed key is a name, not a read. */
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty']);

/** Identifies variable reads, excluding property names and TypeScript type nodes. */
export function readsVariable(parent: Node | null, key: string | null): boolean {
  if (!parent) return true;
  if (parent.type.startsWith('TS')) return false;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent['computed']) return false;
  return !(KEYED.has(parent.type) && key === 'key' && !parent['computed']);
}
