import { violation, type SourceFile } from './source';
import { isValueProperty, lineOf, parseProgram, type Node } from './syntax';

const node = (v: unknown): Node | undefined => v !== null && typeof v === 'object' && typeof (v as Node).type === 'string' ? v as Node : undefined;
const child = (n: Node, key: string): Node | undefined => node(n[key]);
const children = (n: Node): Node[] => Object.values(n).flatMap((v) => Array.isArray(v) ? v.map(node).filter((n): n is Node => !!n) : node(v) ? [node(v)!] : []);
const name = (n: Node | undefined): string => String(n?.name ?? n?.value ?? '');
const property = (n: Node): string => name(child(n, 'property'));
// Methods are FunctionExpression values of Property and MethodDefinition nodes.
const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
const READ = new Set(['get', 'all', 'iterate']);
interface FunctionSite { key: string; ast: Node; file: SourceFile; reads: { ast: Node; sql: string; method: string }[]; calls: Set<string> }

/** Conservative local call graph: declarations cannot hide synchronous reads behind helpers or omitted reads flags. */
export function servedReadViolations(files: SourceFile[]): string[] {
  const functions: FunctionSite[] = [];
  const served = new Set<string>();
  const roots = new Map<string, { ast: Node; file: SourceFile }>();
  const exceptions = new Set<string>();
  const statements = new Map<string, string>();
  for (const file of files.filter((f) => f.rel.startsWith('core/') || f.rel.startsWith('shared/'))) {
    const program = parseProgram(file.text, file.rel);
    const source = (n: Node | undefined): string => n ? file.text.slice(n.start, n.end) : '';
    const walk = (n: Node, parent?: Node, current?: FunctionSite): void => {
      if (FUNCTION.test(n.type)) {
        const key = name(child(n, 'id')) || name(child(n, 'key')) || (parent?.type === 'VariableDeclarator' ? name(child(parent, 'id')) : name(parent && child(parent, 'key')));
        current = { key, ast: n, file, reads: [], calls: new Set() };
        functions.push(current);
      }
      if (isValueProperty(n) && /syncReads\s*:/.test(source(child(n, 'value')))) exceptions.add(name(child(n, 'key')));
      if (n.type === 'VariableDeclarator') {
        const init = child(n, 'init');
        if (init?.type === 'CallExpression' && property(child(init, 'callee')!) === 'prepare') statements.set(name(child(n, 'id')), source((init.arguments as Node[])[0]));
      }
      if (n.type === 'CallExpression') {
        const callee = child(n, 'callee')!;
        const member = property(callee);
        if (member === 'serve') {
          const impl = (n.arguments as Node[])[0];
          if (impl?.type === 'ObjectExpression') for (const p of impl.properties as Node[]) {
            const key = name(child(p, 'key'));
            served.add(key);
            roots.set(key, { ast: child(p, 'value') ?? p, file });
          }
          else if (impl?.type === 'MemberExpression') served.add(property(impl));
        }
        if (current) {
          const called = callee.type === 'Identifier' ? name(callee) : member;
          const receiver = source(child(callee, 'object'));
          if (called && !/(?:^|\.)(?:events|channels)$/.test(receiver)) current.calls.add(called);
          if (READ.has(member)) {
            let target = child(callee, 'object');
            while (target?.type === 'CallExpression' && ['raw', 'pluck', 'expand'].includes(property(child(target, 'callee')!))) target = child(child(target, 'callee')!, 'object');
            const prepare = target?.type === 'CallExpression' && property(child(target, 'callee')!) === 'prepare' ? target : undefined;
            const sql = prepare ? source((prepare.arguments as Node[])[0]) : statements.get(name(target));
            if (sql !== undefined) current.reads.push({ ast: n, sql, method: member });
          }
        }
      }
      // setup helpers can return a calls object instead of passing a literal to serve.
      if (isValueProperty(n) && name(child(n, 'key')) === 'calls' && child(n, 'value')?.type === 'ObjectExpression') {
        for (const p of child(n, 'value')!.properties as Node[]) {
          const key = name(child(p, 'key')); served.add(key);
          roots.set(key, { ast: child(p, 'value') ?? p, file });
        }
      }
      for (const c of children(n)) walk(c, n, current);
    };
    walk(program);
  }
  const found = new Set<string>();
  for (const member of served) {
    const seen = new Set<FunctionSite>();
    const visit = (key: string, initial = false): void => {
      const root = roots.get(key);
      for (const fn of functions.filter((f) => initial && root
        ? f.file === root.file && f.ast.start >= root.ast.start && f.ast.end <= root.ast.end
        : f.key === key)) {
        if (seen.has(fn)) continue;
        seen.add(fn);
        for (const read of fn.reads) {
          const entity = read.method === 'get' ? /\bWHERE\b[\s\S]*=/ : /\bWHERE\b[\s\S]*\b(?:id|message_id|seq)\s*(?:=|IN\s*\()/i;
          const point = entity.test(read.sql) && !/\b(?:COUNT|SUM|AVG|MIN|MAX|GROUP|DISTINCT)\b/i.test(read.sql);
          if (exceptions.has(member) && point) continue;
          found.add(violation(fn.file.rel, lineOf(fn.file.text, read.ast), `served ${member}: synchronous read via ${fn.key}; use ctx.storage.read (syncReads permits indexed point lookups only)`));
        }
        for (const call of fn.calls) visit(call);
      }
    };
    visit(member, true);
  }
  return [...found];
}
