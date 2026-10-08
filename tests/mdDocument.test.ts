import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import { isMarkdownFile, isTextFile } from '@shared/textFiles';
import { isSafeMarkdownHref } from '../src/renderer/src/ui/mdParse';
import { tokenizeMath } from '../src/renderer/src/ui/mdMath';
import { MARKDOWN_TOKEN_LIMIT, documentTokens, parseDocument, type DocumentNode } from '../src/renderer/src/ui/mdDocumentParse';

function flatten(nodes: DocumentNode[]): DocumentNode[] {
  return nodes.flatMap((node) => [node, ...('children' in node ? flatten(node.children)
    : node.kind === 'table' ? flatten([...node.header, ...node.rows.flat()].flatMap((cell) => cell.children)) : [])]);
}
const parsed = (text: string) => flatten(parseDocument(text).nodes);
const textOf = (nodes: DocumentNode[]) => flatten(nodes).flatMap((node) => node.kind === 'text' ? [node.text] : []).join('');

describe('formatted attachment endings', () => {
  it.each(['md', 'markdown', 'mkd', 'mkdown'])('defaults .%s to Formatted, case-insensitively', (ending) => {
    expect(isMarkdownFile(`notes.${ending.toUpperCase()}`)).toBe(true);
    expect(isTextFile(`notes.${ending}`)).toBe(true);
  });
  it.each(['notes.txt', 'notes.md.txt', 'notes.mdx', 'notes'])('keeps %s in Source', (filename) => {
    expect(isMarkdownFile(filename)).toBe(false);
  });
});

describe('dollar math tokenizer', () => {
  it('recognizes inline math amid text', () => {
    expect(tokenizeMath('$x^2$ next')).toEqual({ type: 'math', raw: '$x^2$', text: 'x^2', display: false });
    expect(parsed('Before $x^2$ after').filter((node) => node.kind === 'math')).toEqual([{ kind: 'math', text: 'x^2', display: false }]);
  });
  it('recognizes multiline display math as a block', () => {
    expect(parseDocument('Before\n\n$$\nx^2 + y^2\n$$\n\nAfter').nodes[1]).toEqual({ kind: 'math', text: '\nx^2 + y^2\n', display: true });
    expect(parsed('Before $$x^2$$ after').find((node) => node.kind === 'math')).toEqual({ kind: 'math', text: 'x^2', display: true });
  });
  it.each(['$5 and $10', '$ x$', '$x $', '$x$2', '$', '$$'])('does not tokenize %s as inline math', (text) => {
    expect(tokenizeMath(text)).toBeUndefined();
    expect(parsed(text).some((node) => node.kind === 'math')).toBe(false);
  });
  it('respects escaped dollars', () => {
    expect(tokenizeMath('$a\\$b$')?.text).toBe('a\\$b');
    expect(parsed('\\$x$').some((node) => node.kind === 'math')).toBe(false);
  });
  it('does not absorb currency text into a later math expression', () => {
    expect(parsed('$5 and $10 total $x$').filter((node) => node.kind === 'math')).toEqual([{ kind: 'math', text: 'x', display: false }]);
  });
  it('leaves math delimiters in inline, fenced, and indented code untouched', () => {
    const nodes = parsed('`$x$`\n\n```tex\n$$x^2$$\n```\n\n    $z$');
    expect(nodes.some((node) => node.kind === 'math')).toBe(false);
    expect(nodes.filter((node) => node.kind === 'code' || node.kind === 'inlineCode')).toEqual([
      { kind: 'inlineCode', text: '$x$' }, { kind: 'code', text: '$$x^2$$', language: 'tex' }, { kind: 'code', text: '$z$', language: '' },
    ]);
  });
});

describe('document token rendering contract', () => {
  it('drops block and inline HTML while keeping surrounding text', () => {
    const result = parseDocument('<script>alert(1)</script>\n\nBefore <b>bold</b> after <img src=x onerror=alert(1)>');
    expect(textOf(result.nodes)).toBe('Before bold after ');
    expect(JSON.stringify(result.nodes)).not.toMatch(/script|onerror|<b>|<img/);
  });
  it('renders images as safe links using their alt text', () => {
    const links = parsed('![diagram](https://example.com/a.png)').filter((node) => node.kind === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'link', href: 'https://example.com/a.png' });
    expect(textOf(links)).toBe('diagram');
  });
  it.each(['javascript:alert(1)', 'data:text/html,boom', 'file:///C:/secret', 'mailto:a@example.com', '//example.com/x', '/relative'])('rejects %s in links and images', (href) => {
    expect(isSafeMarkdownHref(href)).toBe(false);
    const nodes = parseDocument(`[label](<${href}>) ![alt](<${href}>)`).nodes;
    expect(flatten(nodes).some((node) => node.kind === 'link')).toBe(false);
    expect(textOf(nodes)).toBe('label alt');
  });
  it.each(['https://example.com', 'http://example.com', 'HTTPS://example.com'])('shares chat link safety for %s', (href) => {
    expect(isSafeMarkdownHref(href)).toBe(true);
    expect(parsed(`[label](${href})`).find((node) => node.kind === 'link')).toMatchObject({ href });
  });
  it('supports GFM structure, ordered starts, task lists, and aligned tables', () => {
    const nodes = parsed('# Heading\n\n**bold** *em* ~~del~~ `code`\n\n> quote\n\n---\n\n3. ordered\n\n- [x] done\n- [ ] todo\n\n| left | right | center |\n| :-- | --: | :-: |\n| a | b | c |');
    expect(nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['heading', 'strong', 'em', 'del', 'inlineCode', 'quote', 'hr', 'list', 'item', 'table']));
    expect(nodes.find((node) => node.kind === 'list')).toMatchObject({ ordered: true, start: 3 });
    expect(nodes.filter((node) => node.kind === 'item' && node.task)).toMatchObject([{ checked: true }, { checked: false }]);
    expect(nodes.find((node) => node.kind === 'table')).toMatchObject({ header: [{ align: 'left' }, { align: 'right' }, { align: 'center' }] });
  });
  it('highlights a fence using its language, excluding trailing metadata', () => {
    expect(parsed('```ts title=example\nconst x = 1;\n```').find((node) => node.kind === 'code')).toEqual({ kind: 'code', text: 'const x = 1;', language: 'ts' });
  });
});

describe('Discord document token budget', () => {
  it('stops at 5,000 tokens and omits the remainder instead of showing source', () => {
    const result = parseDocument(`${'*word* '.repeat(MARKDOWN_TOKEN_LIMIT)}TAIL`);
    expect(result.count).toBe(MARKDOWN_TOKEN_LIMIT);
    expect(result.cut).toBe(true);
    expect(textOf(result.nodes)).not.toContain('TAIL');
    expect(flatten(result.nodes)).toHaveLength(MARKDOWN_TOKEN_LIMIT);
  });
  it('only reports a cut when there are further tokens', () => {
    const tokens = new Marked().lexer('a'); // paragraph + text
    expect(documentTokens(tokens, 2)).toMatchObject({ count: 2, cut: false });
    expect(documentTokens(tokens, 1)).toMatchObject({ count: 1, cut: true });
    expect(documentTokens([], 0)).toMatchObject({ nodes: [], count: 0, cut: false });
  });
  it('counts dropped HTML and nested list items in the same budget', () => {
    expect(documentTokens(new Marked().lexer('<script>ignored</script>\n\nTAIL'), 1)).toMatchObject({ nodes: [], count: 1, cut: true });
    const result = documentTokens(new Marked().lexer('- first\n- second'), 4);
    expect(result).toMatchObject({ count: 4, cut: true });
    expect(textOf(result.nodes)).toBe('first');
  });
  it('stops within a table cell before subsequent rows', () => {
    const result = documentTokens(new Marked().lexer('| h |\n| - |\n| **first** |\n| TAIL |'), 3);
    expect(result).toMatchObject({ count: 3, cut: true });
    expect(textOf(result.nodes)).not.toContain('TAIL');
  });
});
