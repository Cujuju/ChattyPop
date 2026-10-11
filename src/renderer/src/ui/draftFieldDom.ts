/** Canonical text positions over an editable DOM: emoji count as their complete draft token, not their alt text. */
type Point = { node: Node; offset: number };
type Unit = { text: string; start: Point; end: Point; atomic: boolean };
const BLOCKS = new Set(['DIV', 'P']);
const tokenOf = (node: Node): string | null => node instanceof HTMLElement ? node.getAttribute('data-draft-emoji') : null;
const edge = (node: Node, after = false): Point => ({ node: node.parentNode!, offset: [...node.parentNode!.childNodes].indexOf(node as ChildNode) + Number(after) });

/** Browser line containers and their terminal filler <br> are normalized to plain newlines. */
function unitsIn(root: Node): Unit[] {
  const units: Unit[] = [];
  const visit = (parent: Node): void => {
    const children = [...parent.childNodes];
    children.forEach((node, index) => {
      const block = node instanceof HTMLElement && BLOCKS.has(node.tagName);
      if (block && index > 0 && !units.at(-1)?.text.endsWith('\n'))
        units.push({ text: '\n', start: edge(node), end: { node, offset: 0 }, atomic: true });
      const token = tokenOf(node);
      if (token !== null) units.push({ text: token, start: edge(node), end: edge(node, true), atomic: true });
      else if (node.nodeType === Node.TEXT_NODE)
        units.push({ text: node.textContent ?? '', start: { node, offset: 0 }, end: { node, offset: node.textContent?.length ?? 0 }, atomic: false });
      else if (node instanceof HTMLElement && node.tagName === 'BR') {
        if (node.hasAttribute('data-draft-end')) return;
        // The browser leaves a final BR to make the last empty line editable. It isn't an extra newline.
        if (index < children.length - 1 || (children.length > 1 && children[index - 1] instanceof Text))
          units.push({ text: '\n', start: edge(node), end: edge(node, true), atomic: true });
      } else visit(node);
      if (block && index < children.length - 1 && !(children[index + 1] instanceof HTMLElement && BLOCKS.has((children[index + 1] as HTMLElement).tagName)) && !units.at(-1)?.text.endsWith('\n'))
        units.push({ text: '\n', start: edge(node, true), end: edge(node, true), atomic: true });
    });
  };
  visit(root);
  return units;
}

export const readDraftField = (root: Node): string => unitsIn(root).map((unit) => unit.text).join('');

export function draftFieldOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return readDraftField(range.cloneContents()).length;
}

function pointAt(root: HTMLElement, offset: number, forward: boolean): Point {
  let start = 0;
  for (const unit of unitsIn(root)) {
    const end = start + unit.text.length;
    if (offset <= end) {
      if (!unit.atomic) return { node: unit.start.node, offset: Math.max(0, offset - start) };
      return offset <= start ? unit.start : offset >= end || forward ? unit.end : unit.start;
    }
    start = end;
  }
  return { node: root, offset: root.childNodes.length };
}

export function selectDraftField(root: HTMLElement, from: number, to = from): void {
  const start = pointAt(root, from, false);
  const end = pointAt(root, to, from !== to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
