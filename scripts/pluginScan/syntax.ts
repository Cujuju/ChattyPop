// Parses each file once, distinguishing code from comments, strings, and regular expressions.
import { parse } from '@babel/parser';
import type { SourceFile } from './source';

/** A syntax node, as far as the rules read it. */
export interface Node {
  type: string;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

/** Files whose syntax includes JSX; in the others `<T>x` is a type assertion. */
const JSX_FILE = /\.[jt]sx$/;
const trees = new WeakMap<SourceFile, Node>();

/** `file`'s program; throws on a syntax error, naming its line. */
export function syntaxOf(file: SourceFile): Node {
  const known = trees.get(file);
  if (known) return known;
  const tree = parse(file.text, { sourceType: 'module', plugins: JSX_FILE.test(file.rel) ? ['typescript', 'jsx'] : ['typescript'] }).program as unknown as Node;
  trees.set(file, tree);
  return tree;
}

/** Visits each node with its parent and containing property. */
export function walk(node: Node, visit: (node: Node, parent: Node | null, key: string | null) => void, parent: Node | null = null, key: string | null = null): void {
  visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    if (Array.isArray(v)) for (const item of v) isNode(item) && walk(item, visit, node, k);
    else if (isNode(v)) walk(v, visit, node, k);
  }
}

/** `node`'s 1-based line. */
export const lineOf = (node: Node): number => node.loc?.start.line ?? 0;

/** A string literal's value, or a template literal's without substitutions; null for anything computed. */
export function literalString(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'StringLiteral') return node['value'] as string;
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as unknown[]).length) return null;
  return ((node['quasis'] as { value: { cooked: string | null } }[])[0]?.value.cooked) ?? null;
}

/** A member's property name: `a.name` or `a['name']`; null when computed otherwise. */
export function propertyName(member: Node): string | null {
  const property = member['property'] as Node;
  if (!member['computed']) return property.type === 'Identifier' ? (property['name'] as string) : null;
  return literalString(property);
}

/** Identifies variable reads, excluding property names and TypeScript type nodes. */
export function readsVariable(parent: Node | null, key: string | null): boolean {
  if (!parent) return true;
  if (parent.type.startsWith('TS')) return false;
  const member = parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression';
  if (member && key === 'property' && !parent['computed']) return false;
  const keyed = /^(?:Object(?:Property|Method)|Class(?:Property|Method|PrivateProperty|AccessorProperty))$/.test(parent.type);
  return !(keyed && key === 'key' && !parent['computed']);
}
