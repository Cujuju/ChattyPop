import { parse } from '@babel/parser';
import { violation, type SourceFile } from './source';

interface Ast {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}
interface Binding { source: string; name: string }
interface Scope { parent?: Scope; bindings: Map<string, Binding | null> }
export interface SolidSite extends Binding { line: number }
export interface SolidScan { imports: SolidSite[]; initial: SolidSite[]; escapes: { line: number; message: string }[] }
const COMPUTATIONS = new Set(['createMemo', 'createEffect', 'createComputed', 'createRenderEffect', 'createResource', 'createReaction', 'createDeferred', 'createSelector']);
const SOURCES = new Set(['solid-js', 'solid-js/web', 'solid-js/store']);
const GUARDED = ['createRoot', 'batch', 'onCleanup', 'catchError', 'ErrorBoundary'];
const STORE_GUARDED = ['createStore', 'createMutable'];
const DIRECT_SOURCES = new Set(['solid-js', 'solid-js/store']);
// The host registry passes plugins the host's real Solid instances.
const HOST_REGISTRY = 'src/renderer/src/plugins/installedRenderers.ts';
// Only installed-module plumbing declares, publishes or reads the raw host namespaces.
const HOST_MODULE_LOADERS = new Set(['src/shared/installedPlugins.ts', 'src/shared/hostModules.ts', 'src/renderer/src/plugins/installedLoader.ts']);
const HOST_MODULE_ACCESS = new Set(['HOST_MODULES_KEY', 'hostModules']);
const SDK_REPLACEMENTS: Record<string, string> = {
  createRoot: 'containedRoot or ownedOrContained',
  batch: 'batchWrites',
  onCleanup: 'onCleanup',
  createStore: 'createStore',
  createMutable: 'createStore',
};
const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/;
const node = (v: unknown): Ast | undefined => v !== null && typeof v === 'object' && typeof (v as Ast).type === 'string' ? v as Ast : undefined;
const child = (n: Ast, key: string): Ast | undefined => node(n[key]);
const list = (n: Ast, key: string): Ast[] => Array.isArray(n[key]) ? n[key].map(node).filter((n): n is Ast => !!n) : [];
const children = (n: Ast): Ast[] => Object.values(n).flatMap((v) => Array.isArray(v) ? v.map(node).filter((n): n is Ast => !!n) : node(v) ? [node(v)!] : []);
const name = (n: Ast | undefined): string | undefined => typeof n?.name === 'string' ? n.name : typeof n?.value === 'string' ? n.value : undefined;
const moduleName = (n: Ast | undefined): string | undefined => n?.type === 'TemplateLiteral' && list(n, 'expressions').length === 0
  ? (list(n, 'quasis')[0]?.value as { cooked?: string })?.cooked : name(n);
const directOnly = (binding: Binding): boolean => binding.source === 'solid-js' && (COMPUTATIONS.has(binding.name) || GUARDED.includes(binding.name))
  || binding.source === 'solid-js/store' && STORE_GUARDED.includes(binding.name)
  || binding.source === 'solid-js/web' && binding.name === 'render';

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

function scan(source: string, hostFile?: string): SolidScan {
  const hostRegistry = hostFile === HOST_REGISTRY;
  const program = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program as unknown as Ast;
  const result: SolidScan = { imports: [], initial: [], escapes: [] };
  const escape = (n: Ast, message: string): void => { result.escapes.push({ line: n.loc?.start.line ?? 1, message }); };
  const module: Scope = { bindings: new Map() };
  statements(list(program, 'body'), module);
  hoisted(program, module);
  for (const n of list(program, 'body')) {
    const exportedFrom = name(child(n, 'source'));
    if (exportedFrom && SOURCES.has(exportedFrom) && n.exportKind !== 'type') {
      if (n.type === 'ExportNamedDeclaration') {
        for (const specifier of list(n, 'specifiers')) {
          const imported = name(child(specifier, 'local'));
          if (imported && specifier.exportKind !== 'type') {
            const binding = { source: exportedFrom, name: imported };
            result.imports.push({ ...binding, line: specifier.loc?.start.line ?? 1 });
            if (directOnly(binding)) escape(specifier, `${imported}: binding may only be used as a direct call's callee`);
          }
        }
      }
      if (n.type === 'ExportAllDeclaration' || list(n, 'specifiers').some((s) => s.type === 'ExportNamespaceSpecifier')) {
        if (DIRECT_SOURCES.has(exportedFrom)) escape(n, `${exportedFrom}: raw namespace re-exports are forbidden`);
        const names = exportedFrom === 'solid-js' ? GUARDED : exportedFrom === 'solid-js/store' ? STORE_GUARDED : ['render'];
        for (const name of names) result.imports.push({ source: exportedFrom, name, line: n.loc?.start.line ?? 1 });
      }
    }
    if (n.type !== 'ImportDeclaration' || n.importKind === 'type') continue;
    const from = name(child(n, 'source'));
    for (const specifier of list(n, 'specifiers')) {
      const local = name(child(specifier, 'local'));
      if (!local) continue;
      const imported = specifier.type === 'ImportNamespaceSpecifier' ? '*' : name(child(specifier, 'imported'));
      if (hostFile && n.importKind !== 'type' && specifier.importKind !== 'type') {
        if (imported === 'RENDERER_HOST_MODULES') escape(specifier, 'RENDERER_HOST_MODULES must remain private to the renderer registry');
        if (imported && HOST_MODULE_ACCESS.has(imported) && !HOST_MODULE_LOADERS.has(hostFile)) escape(specifier, `${imported}: raw host modules are restricted to installed-module loaders`);
      }
      if (hostRegistry && from === './installedLoader' && imported === 'loadRenderers') {
        module.bindings.set(local, { source: from, name: imported });
        continue;
      }
      if (!from || !SOURCES.has(from) || specifier.importKind === 'type') {
        module.bindings.set(local, null);
        continue;
      }
      const binding = imported ? { source: from, name: imported } : null;
      module.bindings.set(local, binding);
      if (imported === '*' && DIRECT_SOURCES.has(from) && !hostRegistry) escape(specifier, `${from}: namespace imports are forbidden; use named imports and SDK containment`);
      if (binding && imported !== '*') result.imports.push({ ...binding, line: specifier.loc?.start.line ?? 1 });
    }
  }

  const hostValues = new Set<Ast>();
  let hostMapId: Ast | undefined;
  if (hostRegistry) for (const declaration of list(program, 'body')) {
    if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const entry of list(declaration, 'declarations')) {
      if (name(child(entry, 'id')) !== 'RENDERER_HOST_MODULES') continue;
      hostMapId = child(entry, 'id');
      const map = unwrap(child(entry, 'init'));
      if (map?.type !== 'ObjectExpression') continue;
      for (const property of list(map, 'properties')) {
        if (property.type !== 'ObjectProperty') continue;
        const value = unwrap(child(property, 'value'));
        const binding = value?.type === 'Identifier' ? lookup(module, String(value.name)) : undefined;
        if (binding?.name === '*' && DIRECT_SOURCES.has(binding.source) && name(child(property, 'key')) === binding.source) hostValues.add(value!);
      }
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

  function visit(n: Ast | undefined, scope: Scope, active: boolean, parent?: Ast, key?: string, directCall = false): void {
    if (!n || n.type === 'ImportDeclaration' || n.type.startsWith('TS') && n.type.endsWith('Type')) return;
    if (hostFile) {
      const identifier = name(n);
      if (identifier === 'RENDERER_HOST_MODULES' && n !== hostMapId) {
        const loader = parent?.type === 'CallExpression' && key === 'arguments' ? resolve(child(parent, 'callee'), scope) : undefined;
        if (!hostRegistry || loader?.source !== './installedLoader' || loader.name !== 'loadRenderers' || list(parent!, 'arguments').at(-1) !== n) {
          escape(n, 'RENDERER_HOST_MODULES may only be passed directly to loadRenderers');
        }
      }
      if (identifier && HOST_MODULE_ACCESS.has(identifier) && !HOST_MODULE_LOADERS.has(hostFile)) {
        escape(n, `${identifier}: raw host modules are restricted to installed-module loaders`);
      }
    }
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') {
      if (key === 'id' || (key === 'key' || key === 'property') && !parent?.computed || key === 'exported') return;
      const binding = lookup(scope, String(n.name));
      if (binding?.name === '*' && DIRECT_SOURCES.has(binding.source) && hostRegistry && !hostValues.has(n)) {
        escape(n, `${binding.source}: namespace bindings may only be values in RENDERER_HOST_MODULES`);
      }
      if (binding && directOnly(binding) && !directCall) escape(n, `${binding.name}: binding may only be used as a direct call's callee`);
      return;
    }
    if (n.type === 'ExportNamedDeclaration' && child(n, 'source')) {
      if (hostFile) for (const specifier of list(n, 'specifiers')) visit(child(specifier, 'local'), scope, active, specifier, 'local');
      return;
    }
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
      const from = moduleName(list(n, 'arguments')[0]);
      if (from && DIRECT_SOURCES.has(from) && (callee?.type === 'Import' || callee?.type === 'Identifier' && callee.name === 'require')) {
        escape(n, `${from}: require and dynamic import are forbidden; use named imports and SDK containment`);
      }
      const binding = resolve(callee, scope);
      if (active && binding?.source === 'solid-js' && COMPUTATIONS.has(binding.name)) result.initial.push({ ...binding, line: n.loc?.start.line ?? 1 });
      let immediate = callee && FUNCTION.test(callee.type) ? callee : undefined;
      if (callee?.type === 'MemberExpression' && ['call', 'apply'].includes(name(child(callee, 'property')) ?? '')) {
        const object = unwrap(child(callee, 'object'));
        if (object && FUNCTION.test(object.type)) immediate = object;
      }
      if (immediate) visitFunction(immediate, scope, active);
      else visit(callee, scope, active, n, 'callee', true);
      for (const argument of list(n, 'arguments')) visit(argument, scope, active, n, 'arguments');
      return;
    }
    if (n.type === 'ImportExpression') {
      const from = moduleName(child(n, 'source'));
      if (from && DIRECT_SOURCES.has(from)) escape(n, `${from}: dynamic import is forbidden; use named imports and SDK containment`);
    }
    for (const [key, value] of Object.entries(n)) {
      const nested = Array.isArray(value) ? value.map(node).filter((n): n is Ast => !!n) : node(value) ? [node(value)!] : [];
      for (const c of nested) visit(c, scope, active, n, key);
    }
  }
  visit(program, module, true);
  return result;
}

/** Resolves Solid bindings and eager computations. Named factory calls require a separate audit. */
export const scanSolid = (source: string): SolidScan => scan(source);

/** Host scans allow namespace values only in the named host-module registry. */
export const scanHostSolid = (file: SourceFile): SolidScan => scan(file.text, file.rel);

/** Renderer and page state uses the SDK's containment leaves. */
export function containmentViolations(file: SourceFile): string[] {
  if (!/^(renderer|page)\//.test(file.rel)) return [];
  const scan = scanSolid(file.text);
  const raw = scan.imports.filter((site) => site.source === 'solid-js' && ['createRoot', 'batch', 'onCleanup'].includes(site.name)
    || site.source === 'solid-js/store' && STORE_GUARDED.includes(site.name));
  return [
    ...scan.escapes.map((site) => violation(file.rel, site.line, site.message)),
    ...raw.map((site) => violation(file.rel, site.line, `${site.name}: use ${SDK_REPLACEMENTS[site.name]} from @plugin-sdk/renderer`)),
    ...scan.initial.map((site) => violation(file.rel, site.line, `${site.name} at module initialization: use containedRoot or ownedOrContained from @plugin-sdk/renderer`)),
  ];
}
