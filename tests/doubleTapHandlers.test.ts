// A row's double-tap handlers (ui/touch.ts doubleTapToAct), driven by touch event sequences: media keeps its taps, and a
// second finger anywhere in the document spoils the gesture (touch lists are document-wide).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/src/state/ui', () => ({ contextMenu: () => null }));

/**
 * Matches the simple selectors touch.ts uses (tag, [attr], [attr=value], tag[attr], tag:not([attr])); anything else
 * throws, so the fake can't silently pass.
 */
class FakeElement {
  constructor(
    readonly tag: string,
    readonly parent: FakeElement | null = null,
    readonly attrs: Record<string, string> = {},
  ) {}
  matches(selector: string): boolean {
    const hasAttr = (attr: string | undefined, value: string | undefined): boolean => attr !== undefined && attr in this.attrs && (value === undefined || this.attrs[attr] === value);
    return selector.split(',').some((s) => {
      const m = /^([a-z]*)(?:\[([\w-]+)(?:=([\w-]+))?\])?(?::not\(\[([\w-]+)\]\))?$/.exec(s.trim());
      if (!m) throw new Error(`unsupported selector: ${s}`);
      const [, tag, attr, value, notAttr] = m;
      return (!tag || this.tag === tag) && (!attr || hasAttr(attr, value)) && (!notAttr || !hasAttr(notAttr, undefined));
    });
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parent) if (n.matches(selector)) return n;
    return null;
  }
}

const docListeners: ((e: unknown) => void)[] = [];
vi.stubGlobal('Element', FakeElement);
vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: true }) });
vi.stubGlobal('document', { addEventListener: (_type: string, fn: (e: unknown) => void) => void docListeners.push(fn) });

// Renderer modules: imported by path so the node type-check doesn't follow them.
const touchPath = '../src/renderer/src/ui/touch';
type Handler = (e: unknown) => void;
type Handlers = Record<'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel', Handler>;
const { doubleTapToAct } = (await import(touchPath)) as { doubleTapToAct(run: () => void, enabled: () => boolean): Handlers };

/** A quick still tap's press-to-lift time, and a gap well inside the double-tap window. */
const TAP_MS = 80;
const GAP_MS = 120;

const list = new FakeElement('div');
const rowA = new FakeElement('article', list);
const rowB = new FakeElement('article', list);
const textA = new FakeElement('p', rowA);

interface Finger {
  identifier: number;
  clientX: number;
  clientY: number;
  target: FakeElement;
}

/** Each test's clock starts this far past the last one's: touch.ts keeps one app-lifetime multi-touch watch across rows. */
const TEST_EPOCH_MS = 100_000;
let epoch = 0;

/** Fires touch events as a browser would: document listeners first, then row A's handlers when the finger started in row A. */
function touchScreen(h: Handlers) {
  const t0 = (epoch += TEST_EPOCH_MS);
  const active = new Map<number, Finger>();
  const prevented: number[] = [];
  const inRowA = (t: FakeElement): boolean => t.closest('article') === rowA;
  const fire = (type: keyof Handlers, f: Finger, at: number): void => {
    const e = {
      timeStamp: t0 + at,
      target: f.target,
      touches: [...active.values()],
      changedTouches: [f],
      cancelable: true,
      preventDefault: () => void prevented.push(at),
    };
    if (type === 'onTouchStart') docListeners.forEach((l) => l(e));
    if (inRowA(f.target)) h[type](e);
  };
  return {
    prevented,
    down(id: number, target: FakeElement, at: number, x = 0, y = 0): void {
      const f = { identifier: id, clientX: x, clientY: y, target };
      active.set(id, f);
      fire('onTouchStart', f, at);
    },
    move(id: number, at: number, x: number, y = 0): void {
      const f = { ...active.get(id)!, clientX: x, clientY: y };
      active.set(id, f);
      fire('onTouchMove', f, at);
    },
    up(id: number, at: number): void {
      const f = active.get(id)!;
      active.delete(id);
      fire('onTouchEnd', f, at);
    },
    tap(target: FakeElement, at: number): void {
      this.down(0, target, at);
      this.up(0, at + TAP_MS);
    },
  };
}

let runs = 0;
let screen: ReturnType<typeof touchScreen>;
beforeEach(() => {
  runs = 0;
  screen = touchScreen(doubleTapToAct(() => void runs++, () => true));
});

const SECOND = TAP_MS + GAP_MS;

describe('a double tap on a row', () => {
  it('runs once on text, and cancels the second tap so it neither clicks nor selects', () => {
    screen.tap(textA, 0);
    screen.tap(textA, SECOND);
    expect(runs).toBe(1);
    expect(screen.prevented).toEqual([SECOND + TAP_MS]);
  });

  it.each([
    ['an embed thumbnail', 'img', {}],
    ['a Lottie sticker', 'canvas', {}],
    ['an SVG sticker', 'svg', {}],
    ['a role=img sticker', 'span', { role: 'img' }],
    ['a video', 'video', {}],
    ['a link', 'a', { href: 'https://example.com' }],
    ['a button', 'button', {}],
  ])('leaves %s its own taps', (_what, tag, attrs) => {
    const media = new FakeElement(tag, new FakeElement('div', rowA), attrs);
    screen.tap(media, 0);
    screen.tap(media, SECOND);
    expect(runs).toBe(0);
    expect(screen.prevented).toEqual([]);
  });
});

describe('emoji in message text, which Discord treats as text', () => {
  /** A message's text paragraph, as Markdown draws it. */
  const paragraph = (): FakeElement => new FakeElement('span', new FakeElement('p', rowA));

  it.each([
    ['a jumbo emoji-only message', { 'data-jumbo': 'true' }],
    ['an inline emoji', { 'data-jumbo': 'false' }],
    ['an animated emoji, drawn on a canvas', { 'data-jumbo': 'false', role: 'img', tag: 'canvas' }],
  ])('reacts on %s', (_what, { tag = 'img', ...attrs }: Record<string, string>) => {
    const emoji = new FakeElement(tag, paragraph(), { 'data-text-emoji': '', ...attrs });
    screen.tap(emoji, 0);
    screen.tap(emoji, SECOND);
    expect(runs).toBe(1);
  });

  it('is how Markdown draws an emoji', () => {
    const markdown = readFileSync(join(import.meta.dirname, '../src/renderer/src/ui/Markdown.tsx'), 'utf8');
    expect(markdown).toMatch(/<EmojiImage class=\{styles\.emoji\} data-text-emoji /);
  });

  it('leaves an emoji inside a link to the link', () => {
    const emoji = new FakeElement('img', new FakeElement('a', paragraph(), { href: 'https://example.com' }), { 'data-text-emoji': '' });
    screen.tap(emoji, 0);
    screen.tap(emoji, SECOND);
    expect(runs).toBe(0);
  });
});

describe('a second finger anywhere', () => {
  it('spoils the press when it lands on another row while the finger moves', () => {
    screen.tap(textA, 0);
    screen.down(1, textA, SECOND);
    screen.down(2, rowB, SECOND + 10);
    screen.move(1, SECOND + 20, 1);
    screen.up(2, SECOND + 30);
    screen.up(1, SECOND + TAP_MS);
    expect(runs).toBe(0);
  });

  it('spoils the press when it comes and goes on another row while the finger holds still', () => {
    screen.tap(textA, 0);
    screen.down(1, textA, SECOND);
    screen.down(2, rowB, SECOND + 10);
    screen.up(2, SECOND + 30);
    screen.up(1, SECOND + TAP_MS);
    expect(runs).toBe(0);
  });

  it('spoils the first tap too', () => {
    screen.down(1, textA, 0);
    screen.down(2, rowB, 10);
    screen.up(2, 30);
    screen.up(1, TAP_MS);
    screen.tap(textA, SECOND);
    expect(runs).toBe(0);
  });

  it('spoils the press when it lands on the same row', () => {
    screen.tap(textA, 0);
    screen.down(1, textA, SECOND);
    screen.down(2, textA, SECOND + 10);
    screen.up(2, SECOND + 30);
    screen.up(1, SECOND + TAP_MS);
    expect(runs).toBe(0);
  });
});
