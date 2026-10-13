import { parse } from '@babel/parser';

interface Ast {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}
interface Binding { source: string; name: string }
interface Scope { parent?: Scope; bindings: Map<string, Binding | null> }
export interface SolidSite extends Binding { line: number }
export interface SolidScan { imports: SolidSite[]; initial: SolidSite[] }
const COMPUTATIONS = new Set(['createMemo', 'createEffect', 'createComputed', 'createRenderEffect', 'createResource', 'createReaction', 'createDeferred', 'createSelector']);
const SOURCES = new Set(['solid-js', 'solid-js/web']);
const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/;
const node = (v: unknown): Ast | undefined => v !== null && typeof v === 'object' && typeof (v as Ast).type === 'string' ? v as Ast : undefined;
const child = (n: Ast, key: string): Ast | undefined => node(n[key]);
const list = (n: Ast, key: string): Ast[] => Array.isArray(n[key]) ? n[key].map(node).filter((n): n is Ast => !!n) : [];
const children = (n: Ast): Ast[] => Object.values(n).flatMap((v) => Array.isArray(v) ? v.map(node).filter((n): n is Ast => !!n) : node(v) ? [node(v)!] : []);
const name = (n: Ast | undefined): string | undefined => typeof n?.name === 'string' ? n.name : typeof n?.value === 'string' ? n.value : undefined;

function bindPattern(n: Ast | undefined, scope: Scope): void {
  if (!n) return;
  if (n.type === 'Identifier') scope.bindings.set(String(n.name), null);
  else if (n.type === 'AssignmentPattern') bindPattern(child(n, 'left'), scope);
  else if (n.type === 'RestElement') bindPattern(child(n, 'argument'), scope);
  else if (n.type === 'ObjectPattern') for (const p of list(n, 'properties')) bindPattern(child(p, p.type === 'RestElement' ? 'argument' : 'value'), scope);
  else if (n.type === 'ArrayPattern') for (const p of list(n, 'elements')) bindPattern(p, scope);
}

function hoisted(n: Ast, scope: Scope): void {
  if (FUNCTION.test(n.type) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
  if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of list(n, 'declarations')) bindPattern(child(d, 'id'), scope);
  for (const c of children(n)) hoisted(c, scope);
}

function statements(body: Ast[], scope: Scope): void {
  for (let n of body) {
    if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') n = child(n, 'declaration') ?? n;
    if (n.type === 'VariableDeclaration') for (const d of list(n, 'declarations')) bindPattern(child(d, 'id'), scope);
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') bindPattern(child(n, 'id'), scope);
  }
}

function lookup(scope: Scope, key: string): Binding | null | undefined {
  if (scope.bindings.has(key)) return scope.bindings.get(key);
  return scope.parent ? lookup(scope.parent, key) : undefined;
}

function unwrap(n: Ast | undefined): Ast | undefined {
  while (n && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(n.type)) n = child(n, 'expression');
  return n;
}

function resolve(n: Ast | undefined, scope: Scope): Binding | undefined {
  n = unwrap(n);
  if (n?.type === 'Identifier') {
    const binding = lookup(scope, String(n.name));
    return binding && binding.name !== '*' ? binding : undefined;
  }
  if (n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression' || n?.type === 'JSXMemberExpression') {
    const object = unwrap(child(n, 'object'));
    const binding = object && ['Identifier', 'JSXIdentifier'].includes(object.type) ? lookup(scope, String(object.name)) : undefined;
    const property = child(n, 'property');
    const member = n.computed && property?.type !== 'StringLiteral' ? undefined : name(property);
    if (binding?.name === '*' && member) return { source: binding.source, name: member };
  }
  return undefined;
}

/** Resolves Solid bindings and eager computations. Named factory calls require a separate audit. */
export function scanSolid(source: string): SolidScan {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program as unknown as Ast;
  const result: SolidScan = { imports: [], initial: [] };
  const module: Scope = { bindings: new Map() };
  statements(list(program, 'body'), module);
  hoisted(program, module);
  for (const n of list(program, 'body')) {
    if (n.type !== 'ImportDeclaration' || n.importKind === 'type') continue;
    const from = name(child(n, 'source'));
    for (const specifier of list(n, 'specifiers')) {
      const local = name(child(specifier, 'local'));
      if (!local) continue;
      if (!from || !SOURCES.has(from) || specifier.importKind === 'type') {
        module.bindings.set(local, null);
        continue;
      }
      const imported = specifier.type === 'ImportNamespaceSpecifier' ? '*' : name(child(specifier, 'imported'));
      const binding = imported ? { source: from, name: imported } : null;
      module.bindings.set(local, binding);
      if (binding && imported !== '*') result.imports.push({ ...binding, line: specifier.loc?.start.line ?? 1 });
    }
  }

  function visitFunction(n: Ast, parent: Scope, active: boolean): void {
    const scope: Scope = { parent, bindings: new Map() };
    bindPattern(child(n, 'id'), scope);
    for (const p of list(n, 'params')) bindPattern(p, scope);
    const body = child(n, 'body');
    if (body) hoisted(body, scope);
    for (const p of list(n, 'params')) visit(p, scope, active);
    if (n.computed) visit(child(n, 'key'), parent, active);
    visit(body, scope, active);
  }

  function visit(n: Ast | undefined, scope: Scope, active: boolean): void {
    if (!n || n.type === 'ImportDeclaration' || n.type.startsWith('TS') && n.type.endsWith('Type')) return;
    if (FUNCTION.test(n.type)) {
      if (n.computed) visit(child(n, 'key'), scope, active);
      visitFunction(n, scope, false);
      return;
    }
    if (n.type === 'BlockStatement' || n.type === 'StaticBlock' || n.type === 'Program') {
      const block: Scope = n.type === 'Program' ? scope : { parent: scope, bindings: new Map() };
      const body = list(n, 'body');
      statements(body, block);
      if (n.type === 'StaticBlock') hoisted(n, block);
      for (const statement of body) visit(statement, block, active);
      return;
    }
    if (n.type === 'CatchClause') {
      const block: Scope = { parent: scope, bindings: new Map() };
      bindPattern(child(n, 'param'), block);
      visit(child(n, 'body'), block, active);
      return;
    }
    if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(n.type)) {
      const block: Scope = { parent: scope, bindings: new Map() };
      const declaration = child(n, n.type === 'ForStatement' ? 'init' : 'left');
      if (declaration?.type === 'VariableDeclaration') statements([declaration], block);
      for (const c of children(n)) visit(c, block, active);
      return;
    }
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      const block: Scope = { parent: scope, bindings: new Map() };
      bindPattern(child(n, 'id'), block);
      visit(child(n, 'superClass'), scope, active);
      for (const member of list(child(n, 'body')!, 'body')) {
        if (member.type === 'StaticBlock') visit(member, block, active);
        else {
          if (member.computed) visit(child(member, 'key'), block, active);
          if (FUNCTION.test(member.type)) visitFunction(member, block, false);
          else visit(child(member, 'value'), block, active && member.static === true);
        }
      }
      return;
    }
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression' || n.type === 'JSXMemberExpression') {
      const binding = resolve(n, scope);
      if (binding) result.imports.push({ ...binding, line: n.loc?.start.line ?? 1 });
    }
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      const callee = unwrap(child(n, 'callee'));
      const binding = resolve(callee, scope);
      if (active && binding?.source === 'solid-js' && COMPUTATIONS.has(binding.name)) result.initial.push({ ...binding, line: n.loc?.start.line ?? 1 });
      let immediate = callee && FUNCTION.test(callee.type) ? callee : undefined;
      if (callee?.type === 'MemberExpression' && ['call', 'apply'].includes(name(child(callee, 'property')) ?? '')) {
        const object = unwrap(child(callee, 'object'));
        if (object && FUNCTION.test(object.type)) immediate = object;
      }
      if (immediate) visitFunction(immediate, scope, active);
      else visit(callee, scope, active);
      for (const argument of list(n, 'arguments')) visit(argument, scope, active);
      return;
    }
    for (const c of children(n)) visit(c, scope, active);
  }
  visit(program, module, true);
  return result;
}
