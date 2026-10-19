import { parse } from '@babel/parser';
import { violation, type SourceFile } from './source';

interface Ast { type: string; start?: number; end?: number; loc?: { start: { line: number } }; [key: string]: unknown }
const node = (v: unknown): Ast | undefined => v !== null && typeof v === 'object' && typeof (v as Ast).type === 'string' ? v as Ast : undefined;
const child = (n: Ast, key: string): Ast | undefined => node(n[key]);
const children = (n: Ast): Ast[] => Object.values(n).flatMap((v) => Array.isArray(v) ? v.map(node).filter((n): n is Ast => !!n) : node(v) ? [node(v)!] : []);
const name = (n: Ast | undefined): string => String(n?.name ?? n?.value ?? '');
const property = (n: Ast): string => name(child(n, 'property'));
const FUNCTION = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/;
const READ = new Set(['get', 'all', 'iterate']);
interface FunctionSite { key: string; ast: Ast; file: SourceFile; reads: { ast: Ast; sql: string; method: string }[]; calls: Set<string> }

/** Conservative local call graph: declarations cannot hide synchronous reads behind helpers or omitted reads flags. */
export function servedReadViolations(files: SourceFile[]): string[] {
  const functions: FunctionSite[] = [];
  const served = new Set<string>();
  const roots = new Map<string, { ast: Ast; file: SourceFile }>();
  const exceptions = new Set<string>();
  const statements = new Map<string, string>();
  for (const file of files.filter((f) => f.rel.startsWith('core/') || f.rel.startsWith('shared/'))) {
    const program = parse(file.text, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program as unknown as Ast;
    const source = (n: Ast | undefined): string => n ? file.text.slice(n.start, n.end) : '';
    const walk = (n: Ast, parent?: Ast, current?: FunctionSite): void => {
      if (FUNCTION.test(n.type)) {
        const key = name(child(n, 'id')) || name(child(n, 'key')) || (parent?.type === 'VariableDeclarator' ? name(child(parent, 'id')) : name(parent && child(parent, 'key')));
        current = { key, ast: n, file, reads: [], calls: new Set() };
        functions.push(current);
      }
      if (n.type === 'ObjectProperty' && /syncReads\s*:/.test(source(child(n, 'value')))) exceptions.add(name(child(n, 'key')));
      if (n.type === 'VariableDeclarator') {
        const init = child(n, 'init');
        if (init?.type === 'CallExpression' && property(child(init, 'callee')!) === 'prepare') statements.set(name(child(n, 'id')), source((init.arguments as Ast[])[0]));
      }
      if (n.type === 'CallExpression') {
        const callee = child(n, 'callee')!;
        const member = property(callee);
        if (member === 'serve') {
          const impl = (n.arguments as Ast[])[0];
          if (impl?.type === 'ObjectExpression') for (const p of impl.properties as Ast[]) {
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
            const sql = prepare ? source((prepare.arguments as Ast[])[0]) : statements.get(name(target));
            if (sql !== undefined) current.reads.push({ ast: n, sql, method: member });
          }
        }
      }
      // setup helpers can return a calls object instead of passing a literal to serve.
      if (n.type === 'ObjectProperty' && name(child(n, 'key')) === 'calls' && child(n, 'value')?.type === 'ObjectExpression') {
        for (const p of child(n, 'value')!.properties as Ast[]) {
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
        ? f.file === root.file && f.ast.start! >= root.ast.start! && f.ast.end! <= root.ast.end!
        : f.key === key)) {
        if (seen.has(fn)) continue;
        seen.add(fn);
        for (const read of fn.reads) {
          const entity = read.method === 'get' ? /\bWHERE\b[\s\S]*=/ : /\bWHERE\b[\s\S]*\b(?:id|message_id|seq)\s*(?:=|IN\s*\()/i;
          const point = entity.test(read.sql) && !/\b(?:COUNT|SUM|AVG|MIN|MAX|GROUP|DISTINCT)\b/i.test(read.sql);
          if (exceptions.has(member) && point) continue;
          found.add(violation(fn.file.rel, read.ast.loc?.start.line ?? 1, `served ${member}: synchronous read via ${fn.key}; use ctx.storage.read (syncReads permits indexed point lookups only)`));
        }
        for (const call of fn.calls) visit(call);
      }
    };
    visit(member, true);
  }
  return [...found];
}
