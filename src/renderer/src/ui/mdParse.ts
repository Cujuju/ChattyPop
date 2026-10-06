import * as linkify from 'linkifyjs';
import { CUSTOM_EMOJI } from '@shared/emoji';

/** Parsed Discord markdown. Text is always plain strings: nothing is ever rendered as HTML. */
export type MdInline =
  | { k: 'text'; text: string }
  | { k: 'strong' | 'em' | 'u' | 's' | 'spoiler'; children: MdInline[] }
  | { k: 'code'; text: string }
  | { k: 'link'; href: string; children: MdInline[] }
  | { k: 'emoji'; id: string; name: string; animated: boolean }
  | { k: 'mention'; kind: 'user' | 'channel' | 'role' | 'everyone'; id: string }
  | { k: 'time'; unix: number; style: string };

export type MdBlock =
  | { k: 'p'; children: MdInline[] }
  | { k: 'h'; level: 1 | 2 | 3; children: MdInline[] }
  | { k: 'subtext'; children: MdInline[] }
  | { k: 'li'; children: MdInline[] }
  | { k: 'quote'; blocks: MdBlock[] }
  | { k: 'codeblock'; lang: string; text: string };

const SAFE_HREF = /^https?:\/\//i;

/** Inline rules use first match. Escaped characters consume backslash pairs so escaped delimiters cannot end styled runs. */
/** A JS Date spans ±8.64e15 ms (100,000,000 days either side of 1970), so ±8.64e12 s. */
const DATE_MAX_S = 8.64e12;

const INLINE: { re: RegExp; make: (m: RegExpExecArray) => MdInline | null }[] = [
  { re: /^\\([^A-Za-z0-9\s])/, make: (m) => ({ k: 'text', text: m[1]! }) },
  { re: /^(`+)([\s\S]*?[^`])\1(?!`)/, make: (m) => ({ k: 'code', text: m[2]!.replace(/^ (.*) $/s, '$1') }) },
  { re: /^<(a?):(\w{2,32}):(\d{15,21})>/, make: (m) => ({ k: 'emoji', animated: m[1] === 'a', name: m[2]!, id: m[3]! }) },
  { re: /^<@!?(\d{15,21})>/, make: (m) => ({ k: 'mention', kind: 'user', id: m[1]! }) },
  { re: /^<#(\d{15,21})>/, make: (m) => ({ k: 'mention', kind: 'channel', id: m[1]! }) },
  { re: /^<@&(\d{15,21})>/, make: (m) => ({ k: 'mention', kind: 'role', id: m[1]! }) },
  { re: /^@(everyone|here)\b/, make: (m) => ({ k: 'mention', kind: 'everyone', id: m[1]! }) },
  // Past a Date's range it can't be shown (and toISOString throws): it stays text.
  { re: /^<t:(-?\d{1,13})(?::([tTdDfFR]))?>/, make: (m) => (Math.abs(Number(m[1])) <= DATE_MAX_S ? { k: 'time', unix: Number(m[1]), style: m[2] ?? 'f' } : null) },
  // Masked link: [text](url) or [text](<url>); only http(s) targets.
  {
    re: /^\[((?:\\.|[^\]\\])+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/,
    make: (m) => (SAFE_HREF.test(m[2]!) ? { k: 'link', href: m[2]!, children: parseInline(m[1]!) } : null),
  },
  { re: /^<(https?:\/\/[^\s>]+)>/, make: (m) => ({ k: 'link', href: m[1]!, children: [{ k: 'text', text: m[1]! }] }) },
  { re: /^\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/, make: (m) => ({ k: 'strong', children: parseInline(m[1]!) }) },
  { re: /^__((?:\\[\s\S]|[^\\])+?)__(?!_)/, make: (m) => ({ k: 'u', children: parseInline(m[1]!) }) },
  { re: /^\*(?!\s)((?:\\[\s\S]|[^\\])+?)(?<!\s)\*(?!\*)/, make: (m) => ({ k: 'em', children: parseInline(m[1]!) }) },
  { re: /^_(?!\s)((?:\\[\s\S]|[^\\])+?)(?<!\s)_(?![A-Za-z0-9_])/, make: (m) => ({ k: 'em', children: parseInline(m[1]!) }) },
  { re: /^~~((?:\\[\s\S]|[^\\])+?)~~/, make: (m) => ({ k: 's', children: parseInline(m[1]!) }) },
  { re: /^\|\|((?:\\[\s\S]|[^\\])+?)\|\|/, make: (m) => ({ k: 'spoiler', children: parseInline(m[1]!) }) },
];

/** Characters that may start an inline rule; text runs stop before them. */
const SPECIAL = /[\\`<@\[*_~|]/;

/** Plain text with bare URLs turned into links. */
function linkifyText(text: string, out: MdInline[]): void {
  let at = 0;
  for (const l of linkify.find(text, 'url')) {
    if (!SAFE_HREF.test(l.href)) continue;
    if (l.start > at) out.push({ k: 'text', text: text.slice(at, l.start) });
    out.push({ k: 'link', href: l.href, children: [{ k: 'text', text: l.value }] });
    at = l.end;
  }
  if (at < text.length) out.push({ k: 'text', text: text.slice(at) });
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) linkifyText(buf, out);
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let matched = false;
    if (SPECIAL.test(src[i]!)) {
      for (const rule of INLINE) {
        const m = rule.re.exec(rest);
        const node = m ? rule.make(m) : null;
        if (m && node) {
          flush();
          out.push(node);
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // Bare URLs can contain special characters (e.g. "_"), so consume a whole URL-looking run at once.
      const url = /^https?:\/\/\S+/.exec(rest);
      const take = url ? url[0].length : 1;
      buf += src.slice(i, i + take);
      i += take;
    }
  }
  flush();
  return out;
}

/** Parses multiline language fences or same-line triple-backtick blocks. Unclosed fences return null/plain text. */
function fencedCode(lines: string[], start: number): { block: MdBlock; end: number } | null {
  const first = lines[start]!.trimEnd();
  const oneLine = /^```([\s\S]+)```$/.exec(first);
  if (oneLine) return { block: { k: 'codeblock', lang: '', text: oneLine[1]! }, end: start };
  const lang = /^```(\w*)$/.exec(first)?.[1];
  const opening = lang === undefined ? first.slice(3) : '';
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j]!.trimEnd();
    if (!line.endsWith('```')) continue;
    const body = [...(opening ? [opening] : []), ...lines.slice(start + 1, j), line.slice(0, -3)];
    return { block: { k: 'codeblock', lang: lang ?? '', text: body.join('\n').replace(/\n$/, '') }, end: j };
  }
  return null;
}

/** Block structure: fenced code, quotes (> line, >>> rest), headings, subtext, list lines, paragraphs. */
export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const endPara = (): void => {
    if (para.length) blocks.push({ k: 'p', children: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code = fencedCode(lines, i);
      if (code) {
        endPara();
        blocks.push(code.block);
        i = code.end;
        continue;
      }
    }
    if (line.startsWith('>>> ')) {
      endPara();
      blocks.push({ k: 'quote', blocks: parseMarkdown([line.slice(4), ...lines.slice(i + 1)].join('\n')) });
      break;
    }
    if (line.startsWith('> ') || line === '>') {
      endPara();
      const quoted: string[] = [];
      for (; i < lines.length && (lines[i]!.startsWith('> ') || lines[i] === '>'); i++) quoted.push(lines[i]!.slice(2));
      i--;
      blocks.push({ k: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      endPara();
      blocks.push({ k: 'h', level: h[1]!.length as 1 | 2 | 3, children: parseInline(h[2]!) });
      continue;
    }
    const sub = /^-# (.+)$/.exec(line);
    if (sub) {
      endPara();
      blocks.push({ k: 'subtext', children: parseInline(sub[1]!) });
      continue;
    }
    const li = /^\s*[-*] (.+)$/.exec(line);
    if (li) {
      endPara();
      blocks.push({ k: 'li', children: parseInline(li[1]!) });
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}

/** True when the text is only custom emoji and whitespace (Discord then shows them large). */
export function isEmojiOnly(src: string, max: number): boolean {
  const stripped = src.replace(CUSTOM_EMOJI, '').trim();
  const n = src.match(CUSTOM_EMOJI)?.length ?? 0;
  return stripped === '' && n > 0 && n <= max;
}
