import { createRenderer } from 'solid-js/universal';

/** A tree adapter for exercising the real Solid renderer without a browser dependency. */
export interface TestNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
  value?: string;
}

export const node = (tag: string, text = ''): TestNode => ({ tag, text, props: {}, children: [], parent: null });

export const { createComponent, createElement, createTextNode, insertNode, insert, spread, setProp, mergeProps, effect, memo, use, render } = createRenderer<TestNode>({
  createElement: (tag) => node(tag),
  createTextNode: (text) => node('#text', text),
  replaceText: (node, text) => { node.text = text; },
  isTextNode: (node) => node.tag === '#text',
  setProperty: (node, name, value) => { node.props[name] = value; },
  insertNode: (parent, child, anchor) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = anchor ? parent.children.indexOf(anchor) : parent.children.length;
    parent.children.splice(index, 0, child);
    child.parent = parent;
  },
  removeNode: (parent, child) => {
    parent.children.splice(parent.children.indexOf(child), 1);
    child.parent = null;
  },
  getParentNode: (node) => node.parent ?? undefined,
  getFirstChild: (node) => node.children[0],
  getNextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
});
