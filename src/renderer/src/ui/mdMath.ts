// Dollar math for Markdown attachments: a Marked extension for $…$ inline and $$…$$ display.
import type { TokenizerExtension } from 'marked';

export interface MathToken {
  type: 'math';
  raw: string;
  text: string;
  display: boolean;
}

/** An odd run of preceding backslashes escapes a delimiter. */
function escaped(src: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && src[--at] === '\\') slashes++;
  return slashes % 2 !== 0;
}

/** Dollar math, with currency-safe single-dollar delimiters. Code is consumed by Marked before this runs inside it. */
export function tokenizeMath(src: string): MathToken | undefined {
  if (!src.startsWith('$')) return;
  const display = src.startsWith('$$');
  const delimiter = display ? '$$' : '$';
  const start = delimiter.length;
  if (!display && (!src[start] || /\s/.test(src[start]!))) return;
  for (let end = start; end < src.length; end++) {
    if (!display && src[end] === '\n') return;
    if (!src.startsWith(delimiter, end) || escaped(src, end)) continue;
    // An unescaped dollar inside a run is a boundary, even when it cannot close math (e.g. the next currency amount).
    if (!display && (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? '') || src[end + 1] === '$')) return;
    const text = src.slice(start, end);
    if (!text.trim()) return;
    return { type: 'math', raw: src.slice(0, end + start), text, display };
  }
}

/** Local extensions, installed once on the document's own Marked instance. */
export const mathExtensions: TokenizerExtension[] = [
  {
    name: 'math',
    level: 'block',
    start: (src) => src.match(/^\$\$/m)?.index,
    tokenizer(src) {
      if (!src.startsWith('$$')) return;
      const token = tokenizeMath(src);
      if (token && /^(?:[ \t]*\n|[ \t]*$)/.test(src.slice(token.raw.length))) return token;
    },
  },
  { name: 'math', level: 'inline', start: (src) => src.indexOf('$'), tokenizer: tokenizeMath },
];
