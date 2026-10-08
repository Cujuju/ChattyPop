// A Markdown attachment drawn formatted: headings, lists, tables, quotes, highlighted code and math.
import { For, Show, createResource } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import temml from 'temml';
import { highlightLines } from './highlight';
import { MarkdownLink } from './MarkdownLink';
import type { DocumentCell, DocumentNode } from './mdDocumentParse';
import styles from './mdDocument.module.css';

/** Decode character references alone: the native parser never receives tags or arbitrary Markdown. */
function decodeText(text: string): string {
  return text.replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);?/gi, (entity) =>
    new DOMParser().parseFromString(entity, 'text/html').body.textContent ?? entity);
}

function Fence(props: { text: string; language: string }) {
  const [lines] = createResource(
    () => [props.text, props.language] as const,
    ([text, language]) => highlightLines(text, language).catch(() => highlightLines(text, 'text')),
  );
  return (
    <pre><code>
      <Show when={lines()} fallback={props.text}>
        <For each={lines()}>{(line, index) => <>
          <Show when={index() > 0}>{'\n'}</Show>
          <For each={line}>{(token) => <span style={token.color ? { color: token.color } : undefined}>{token.content}</span>}</For>
        </>}</For>
      </Show>
    </code></pre>
  );
}

function Math(props: { text: string; display: boolean }) {
  // The sole HTML insertion: Temml escapes its input; trust:false blocks resource-loading and HTML attribute commands.
  const mathML = () => temml.renderToString(props.text, { throwOnError: false, displayMode: props.display, trust: false, errorColor: 'var(--cp-danger)' });
  return <span class={styles.math} data-display={props.display} innerHTML={mathML()} />;
}

function Cells(props: { cells: DocumentCell[]; header?: boolean }) {
  return <For each={props.cells}>{(cell) => (
    <Dynamic component={props.header ? 'th' : 'td'} data-align={cell.align ?? undefined}>
      <Nodes nodes={cell.children} />
    </Dynamic>
  )}</For>;
}

function Nodes(props: { nodes: DocumentNode[]; tight?: boolean }) {
  return <For each={props.nodes}>{(node) => {
    switch (node.kind) {
      case 'text': return node.literal ? node.text : decodeText(node.text);
      case 'inlineCode': return <code>{node.text}</code>;
      case 'group': return <Nodes nodes={node.children} />;
      case 'paragraph': return <Dynamic component={props.tight ? 'span' : 'p'}><Nodes nodes={node.children} /></Dynamic>;
      case 'strong': return <strong><Nodes nodes={node.children} /></strong>;
      case 'em': return <em><Nodes nodes={node.children} /></em>;
      case 'del': return <del><Nodes nodes={node.children} /></del>;
      case 'quote': return <blockquote><Nodes nodes={node.children} /></blockquote>;
      case 'heading': return <Dynamic component={`h${node.level}`}><Nodes nodes={node.children} /></Dynamic>;
      case 'link': return <MarkdownLink href={decodeText(node.href)}><Nodes nodes={node.children} /></MarkdownLink>;
      case 'code': return <Fence text={node.text} language={node.language} />;
      case 'math': return <Math text={node.text} display={node.display} />;
      case 'br': return <br />;
      case 'hr': return <hr />;
      case 'list': return <Dynamic component={node.ordered ? 'ol' : 'ul'} start={node.ordered ? node.start : undefined}>
        <Nodes nodes={node.children} />
      </Dynamic>;
      case 'item': return <li data-task={node.task}>
        <Show when={node.task}><input type="checkbox" checked={node.checked} disabled aria-label={node.checked ? 'Completed task' : 'Incomplete task'} /></Show>
        <Nodes nodes={node.children} tight={!node.loose} />
      </li>;
      case 'table': return <div class={styles.table}><table>
        <thead><tr><Cells cells={node.header} header /></tr></thead>
        <tbody><For each={node.rows}>{(row) => <tr><Cells cells={row} /></tr>}</For></tbody>
      </table></div>;
    }
  }}</For>;
}

/** GFM token tree as Solid elements. Markdown itself is never inserted as HTML. */
export function MarkdownDocument(props: { nodes: DocumentNode[] }) {
  return <article class={styles.document} data-markdown-document><Nodes nodes={props.nodes} /></article>;
}
