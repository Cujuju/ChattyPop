// A Markdown attachment parsed to the elements its viewer may draw (GFM and math), within Discord's token budget.
import { Marked, type Token, type Tokens } from 'marked';
import { isSafeMarkdownHref } from './mdParse';
import { mathExtensions, type MathToken } from './mdMath';

/** Discord stops its Markdown attachment preview after 5,000 tokens, including nested tokens. */
export const MARKDOWN_TOKEN_LIMIT = 5_000;
export const MARKDOWN_CUT_NOTICE = `This Markdown preview stops after ${MARKDOWN_TOKEN_LIMIT.toLocaleString('en-US')} tokens. Switch to Source or download it to read all of it.`;

type Alignment = 'left' | 'center' | 'right' | null;
export interface DocumentCell { align: Alignment; children: DocumentNode[] }
export type DocumentNode =
  | { kind: 'text'; text: string; literal?: boolean }
  | { kind: 'inlineCode'; text: string }
  | { kind: 'group' | 'paragraph' | 'strong' | 'em' | 'del' | 'quote'; children: DocumentNode[] }
  | { kind: 'heading'; level: number; children: DocumentNode[] }
  | { kind: 'link'; href: string; children: DocumentNode[] }
  | { kind: 'list'; ordered: boolean; start: number; children: DocumentNode[] }
  | { kind: 'item'; task: boolean; checked: boolean; loose: boolean; children: DocumentNode[] }
  | { kind: 'table'; header: DocumentCell[]; rows: DocumentCell[][] }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'math'; text: string; display: boolean }
  | { kind: 'br' | 'hr' };

const markdown = new Marked({ gfm: true, extensions: mathExtensions });

/** Converts lexer tokens to the only elements the viewer allows, stopping in document order at the token budget. */
export function documentTokens(tokens: readonly Token[], limit = MARKDOWN_TOKEN_LIMIT) {
  let count = 0;
  let cut = false;
  const walk = (tokens: readonly Token[]): DocumentNode[] => {
    const nodes: DocumentNode[] = [];
    for (const token of tokens) {
      if (count >= limit) { cut = true; break; }
      count++;
      const node = visit(token);
      if (node) nodes.push(node);
      if (cut) break;
    }
    return nodes;
  };
  const cells = (cells: Tokens.TableCell[]): DocumentCell[] => {
    const result: DocumentCell[] = [];
    for (const cell of cells) {
      if (cut) break;
      result.push({ align: cell.align, children: walk(cell.tokens) });
    }
    return result;
  };
  const visit = (token: Token): DocumentNode | undefined => {
    switch (token.type) {
      // Embedded HTML is discarded, never copied into the renderable tree.
      case 'html': case 'space': case 'def': return;
      case 'escape': return { kind: 'text', text: (token as Tokens.Escape).text, literal: true };
      case 'text': {
        const t = token as Tokens.Text;
        const children = t.tokens ? walk(t.tokens) : undefined;
        return children ? { kind: 'paragraph', children } : { kind: 'text', text: t.text };
      }
      case 'paragraph': return { kind: 'paragraph', children: walk((token as Tokens.Paragraph).tokens) };
      case 'strong': case 'em': case 'del': return { kind: token.type, children: walk((token as Tokens.Strong).tokens) };
      case 'blockquote': return { kind: 'quote', children: walk((token as Tokens.Blockquote).tokens) };
      case 'heading': {
        const t = token as Tokens.Heading;
        return { kind: 'heading', level: t.depth, children: walk(t.tokens) };
      }
      case 'codespan': return { kind: 'inlineCode', text: (token as Tokens.Codespan).text };
      case 'code': {
        const t = token as Tokens.Code;
        return { kind: 'code', text: t.text, language: t.lang?.split(/\s+/)[0] ?? '' };
      }
      case 'link': case 'image': {
        const t = token as Tokens.Link | Tokens.Image;
        // Images are text links. Walk their alt tokens too, so they cannot bypass the shared budget.
        const children = walk(t.tokens);
        return isSafeMarkdownHref(t.href) ? { kind: 'link', href: t.href, children } : { kind: 'group', children };
      }
      case 'list': {
        const t = token as Tokens.List;
        return { kind: 'list', ordered: t.ordered, start: Number(t.start) || 1, children: walk(t.items) };
      }
      case 'list_item': {
        const t = token as Tokens.ListItem;
        return { kind: 'item', task: t.task, checked: t.checked ?? false, loose: t.loose, children: walk(t.tokens) };
      }
      case 'table': {
        const t = token as Tokens.Table;
        const header = cells(t.header);
        const rows: DocumentCell[][] = [];
        for (const row of t.rows) {
          if (cut) break;
          rows.push(cells(row));
        }
        return { kind: 'table', header, rows };
      }
      case 'math': {
        const t = token as MathToken;
        return { kind: 'math', text: t.text, display: t.display };
      }
      case 'br': case 'hr': return { kind: token.type };
    }
  };
  return { nodes: walk(tokens), count, cut };
}

export const parseDocument = (text: string) => documentTokens(markdown.lexer(text));
