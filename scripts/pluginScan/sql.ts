// SQL boundary scanner: TypeScript literals, SQL targets and explicit plugin-table expressions. Plugins read archive
// contracts and write only their own namespaced tables.
import { posix } from 'node:path';
import { lineAt, violation, type SourceFile } from './source';

/** String and template contents with expressions retained as distinct SQL tokens. */
export function sqlLiterals(source: string): { sql: string; line: number }[] {
  const found: { sql: string; line: number }[] = [];
  let at = 0;
  const literal = (): void => {
    const start = at;
    const quote = source[at++];
    let sql = '';
    while (at < source.length) {
      const char = source[at++];
      if (char === quote) break;
      if (char === '\\') {
        const escaped = source[at++];
        if (escaped === 'x' || escaped === 'u') {
          const width = escaped === 'x' ? 2 : 4;
          sql += String.fromCharCode(parseInt(source.slice(at, at + width), 16));
          at += width;
        } else sql += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped ?? '';
      } else if (quote === '`' && char === '$' && source[at] === '{') {
        const begin = ++at;
        code(true);
        sql += ` __expr_${Buffer.from(source.slice(begin, at - 1).trim()).toString('hex')}__ `;
      } else sql += char;
    }
    if (/(?:^|[;(])\s*(?:__expr_[\da-f]+__\s*)*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|FROM|JOIN|INTO)\b(?=\s+\S|[*(["`]|\/\*)/i.test(sql)) {
      found.push({ sql, line: source.slice(0, start).split('\n').length });
    }
  };
  const code = (expression: boolean): void => {
    let braces = 0;
    while (at < source.length) {
      const char = source[at];
      if (source.startsWith('//', at)) {
        const end = source.indexOf('\n', at);
        at = end < 0 ? source.length : end;
      } else if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        at = end < 0 ? source.length : end + 2;
      } else if (char === '/' && /(?:^|[=(:,!&|?{\[;]|\breturn)\s*$/.test(source.slice(0, at))) {
        at++;
        let bracket = false;
        while (at < source.length) {
          const next = source[at++];
          if (next === '\\') at++;
          else if (next === '[') bracket = true;
          else if (next === ']') bracket = false;
          else if (next === '/' && !bracket) break;
        }
      } else if (char === '"' || char === "'" || char === '`') literal();
      else {
        at++;
        if (char === '{') braces++;
        if (char === '}') {
          if (expression && braces === 0) return;
          braces--;
        }
      }
    }
  };
  code(false);
  return found;
}

/** Constant declarations whose values come directly from the table namespace helper. */
export function tableConstants(source: string, visible = false): string[] {
  const helper = visible ? 'visibleTable' : 'pluginTable';
  return [...source.matchAll(/\bconst\s+(\w+)\s*=\s*(pluginTable|visibleTable)\(plugin,\s*['"][\w]+['"]\s*\)/g)]
    .filter((match) => match[2] === helper).map((match) => match[1]!);
}

/** Rejected SQL targets; unknown dynamic expressions fail closed. */
export function sqlViolations(sql: string, own: ReadonlySet<string>, allowAll: boolean, visible: ReadonlySet<string> = new Set()): string[] {
  const clean = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g, ' ');
  const tokens = [...clean.matchAll(/[@:$]\w+|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[\w]+|[(),.;]/g)]
    .map(([token]) => /^["`\[]/.test(token) ? token.slice(1, -1).toLowerCase() : token.toLowerCase());
  const ctes = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'with' && tokens[i] !== ',') continue;
    let at = i + 1;
    if (tokens[at] === 'recursive') at++;
    const name = tokens[at++];
    if (tokens[at] === '(') {
      while (at < tokens.length && tokens[at] !== ')') at++;
      at++;
    }
    if (name && tokens[at] === 'as' && tokens[at + 1] === '(') ctes.add(name);
  }
  const errors: string[] = [];
  const target = (at: number, write: boolean): void => {
    let name = tokens[at];
    if (!name) {
      errors.push('missing table target');
      return;
    }
    if (name === '(' || name === 'set') return;
    const qualified = tokens[at + 1] === '.';
    if (qualified) name = tokens[at + 2];
    if (!name) return;
    if (name.startsWith('__expr_')) {
      const expression = Buffer.from(name.slice('__expr_'.length, -2), 'hex').toString();
      if (visible.has(expression) && write) errors.push(`write to visible view: ${expression}`);
      else if (!own.has(expression) && !visible.has(expression)) errors.push(`unowned table expression: ${expression}`);
    } else if (name.startsWith('archive_')) {
      if (write) errors.push(`write to archive view: ${name}`);
      else if (name.startsWith('archive_all_') && !allowAll) errors.push(`unlisted all-data read: ${name}`);
    } else if (write || ((qualified || !ctes.has(name)) && name !== 'json_each')) {
      errors.push(`host or unknown table: ${name}`);
    }
  };
  let depth = 0;
  const from = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '(') depth++;
    if (token === ')') {
      from.delete(depth);
      depth--;
    }
    if (['where', 'group', 'order', 'limit', 'union', 'returning', ';'].includes(token!)) from.delete(depth);
    if (token === 'from') {
      from.add(depth);
      target(i + 1, tokens[i - 1] === 'delete');
    }
    if (token === 'join' || (token === ',' && from.has(depth))) target(i + 1, false);
    if (token === 'into') target(i + 1, true);
    if (token === 'update' && tokens[i + 1] !== 'set') {
      target(i + (tokens[i + 1] === 'or' ? 3 : 1), true);
    }
  }
  return errors;
}

/** Privacy predicates belong to host views, never plugin source. */
export function privacyViolations(source: string): string[] {
  return [...new Set(source.match(/\b(?:privacy_visible|reference_visible|hidden_channels|hidden_ids)\b/g) ?? [])];
}

/** Checks SQL literals and imports against plugin tables, views, and all-data grants. Grants unused by their files are rejected. */
export function archiveViolations(pluginId: string, files: readonly SourceFile[], readers: ReadonlyMap<string, string>): string[] {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const { rel, text } of files) {
    const key = `${pluginId}/${rel}`;
    const own = new Set(tableConstants(text));
    const visible = new Set(tableConstants(text, true));
    for (const name of privacyViolations(text)) {
      offenders.push(violation(rel, lineAt(text, text.search(new RegExp(`\\b${name}\\b`))), `forbidden privacy identifier: ${name}`));
    }
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!match[2]!.startsWith('.')) continue;
      const target = posix.join(posix.dirname(rel), match[2]!);
      const definition = files.find((f) => [`${target}.ts`, `${target}/index.ts`].includes(f.rel));
      if (!definition) continue;
      const declared = tableConstants(definition.text);
      const views = tableConstants(definition.text, true);
      for (const binding of match[1]!.split(',')) {
        const [name, alias] = binding.trim().split(/\s+as\s+/);
        if (name && declared.includes(name)) own.add(alias ?? name);
        if (name && views.includes(name)) visible.add(alias ?? name);
      }
    }
    for (const { sql, line } of sqlLiterals(text)) {
      if (/\barchive_all_\w+/.test(sql)) used.add(key);
      offenders.push(...sqlViolations(sql, own, readers.has(key), visible).map((error) => violation(rel, line, error)));
    }
  }
  const stale = [...readers].filter(([key]) => key.startsWith(`${pluginId}/`) && !used.has(key));
  offenders.push(...stale.map(([key, list]) => `${key.slice(pluginId.length + 1)}: listed in ${list}, but reads no archive_all_ view`));
  return offenders;
}
