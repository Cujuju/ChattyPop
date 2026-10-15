import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildContainment } from './containmentBuild';
import { HEADER_STUBS, VIEWS_SOURCE, WRITES_STUB } from './containedViewsFixture';
import type { TestNode } from './sectionSplitHarness';
import { SNAPSHOT_ADAPTER, SNAPSHOT_SOURCE } from './containmentSnapshotFixture';
import { SEEN_STATE, SEEN_VIEWS_SOURCE } from './seenViewsFixture';

interface View {
  root: TestNode;
  dispose(): void;
  set(value: number): void;
  healthy(): void;
  unhealthy(): void;
  seen: number[];
  counts: { mounts: number; cleanups: number; runs: number };
}
interface Client {
  failure: Error;
  fallbackFailure: Error;
  mount(options?: { shows?: string | { header: { section: string; panelId?: string } }; error?: unknown; children?: number; boundaries?: number; initial?: string; nested?: boolean; throwFallback?: boolean }): View;
  mountProps(): { root: TestNode; dispose(): void; set(value: string): void; reads: string[] };
  holdWrite(): void;
  finishWrite(): void;
}
let client: Client;
interface SeenView {
  root: TestNode;
  dispose(): void;
  set(value: number): void;
  visible(value: boolean): void;
  healthy(): void;
  shows(): boolean;
  loading(value: boolean): void;
  seeded(): number | null;
  id(value: string): void;
  marked: number[];
  shown: string[];
  shownWatermarks: (number | null)[];
}
let seenClient: { mountSeen(kind: string, nested?: boolean, watched?: boolean): SeenView };
interface SnapshotCase {
  environment: Record<string, unknown>;
  stages: { live: boolean }[];
  counts: { cleanups: number; frames: number; removed: number };
  failure: Error;
  cleanupFailure: Error;
  run(): Promise<string>;
}
let snapshots: { makeSnapshot(kind: string): SnapshotCase };
const reports = vi.fn();
const disposers: (() => void)[] = [];
const nodes = (n: TestNode): TestNode[] => [n, ...n.children.flatMap(nodes)];
const text = (n: TestNode): string => n.text + n.children.map(text).join('');
const alerts = (v: { root: TestNode }): TestNode[] => nodes(v.root).filter((n) => n.props.role === 'alert' || n.props.role === 'status');
const buttons = (v: { root: TestNode }): TestNode[] => nodes(v.root).filter((n) => n.tag === 'button');
const press = (button: TestNode): void => (button.props.onClick as () => void)();
const open = (options: Parameters<Client['mount']>[0] = {}): View => {
  const view = client.mount(options);
  disposers.push(view.dispose);
  return view;
};

beforeAll(async () => {
  client = await buildContainment<Client>(VIEWS_SOURCE, { ...HEADER_STUBS, './idbStore': WRITES_STUB });
  seenClient = await buildContainment(SEEN_VIEWS_SOURCE, {
    ...HEADER_STUBS,
    './idbStore': WRITES_STUB,
    'test:seen-state': SEEN_STATE,
    './looking': `export { createOnScreen, pageVisible, windowFocused } from 'test:seen-state';`,
    '@/state/unread': `export { markPanelSeen, panelShown } from 'test:seen-state';`,
  });
  snapshots = await buildContainment(SNAPSHOT_SOURCE, {
    'solid-js/web': SNAPSHOT_ADAPTER,
    '@/theme/snapshot.css?raw': `export default 'Snapshot styles';`,
    './Snapshot.module.css': `export default { stage: 'probe-stage' };`,
  });
});
beforeEach(() => { reports.mockClear(); vi.stubGlobal('reportError', reports); vi.stubGlobal('document', { activeElement: null }); });
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); });
afterAll(() => vi.unstubAllGlobals());

it('9: a failed line names the view, preserves sibling updates and retries with a fresh mount', () => {
  const view = open();
  view.set(1);
  expect(text(alerts(view)[0]!)).toBe('Probe view stopped working.Try again');
  expect(view.counts.cleanups).toBe(1);
  const failedRuns = view.counts.runs;
  view.set(2);
  view.set(3);
  expect(view.seen).toEqual([0, 1, 2, 3]);
  expect(view.counts.runs).toBe(failedRuns);
  view.healthy();
  press(buttons(view)[0]!);
  expect(alerts(view)).toEqual([]);
  expect(view.counts.mounts).toBe(2);
  expect(text(view.root)).toContain('Ready 3');
  view.set(4);
  expect(text(view.root)).toContain('Ready 4');
});

it('10: both children throwing in one update report; a single failure captures only once', () => {
  const two = open({ children: 2 });
  two.set(1);
  expect(reports.mock.calls.map(([error]) => error)).toEqual([client.failure, client.failure]);
  two.set(2);
  expect(reports).toHaveBeenCalledTimes(2);
  reports.mockClear();
  const one = open();
  one.set(1);
  one.set(2);
  one.set(3);
  expect(reports).toHaveBeenCalledTimes(1);
});

it('11: identical failures in two boundaries and again after retry each report', () => {
  const view = open({ boundaries: 2 });
  view.set(1);
  expect(alerts(view)).toHaveLength(2);
  expect(reports.mock.calls.map(([error]) => error)).toEqual([client.failure, client.failure]);
  buttons(view).forEach(press);
  expect(reports.mock.calls.map(([error]) => error)).toEqual([client.failure, client.failure, client.failure, client.failure]);
});

it('12: nothing and name fallbacks draw their policy; Reload waits for pending writes', async () => {
  const nothing = open({ shows: 'nothing' });
  nothing.set(1);
  expect(text(nothing.root)).toBe('1');
  expect(alerts(nothing)).toEqual([]);
  const name = open({ shows: 'name' });
  name.set(1);
  expect(text(name.root)).toBe('Probe view1');
  expect(buttons(name)).toEqual([]);
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  client.holdWrite();
  const page = open({ shows: 'page' });
  page.set(1);
  expect(text(alerts(page)[0]!)).toBe('ChattyPop stopped working.Probe failureUnsent messages and drafts are kept.Reload');
  expect(alerts(page)[0]!.props.role).toBe('alert');
  expect(buttons(page)[0]!.props.class).toBe('cp-primary');
  press(buttons(page)[0]!);
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  expect(page.counts.mounts).toBe(1);
  client.finishWrite();
  await Promise.resolve();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(page.counts.mounts).toBe(1);
});

it('13: initial direct, memo and effect failures reach the fallback', () => {
  for (const initial of ['direct', 'memo', 'effect']) {
    const view = open({ initial });
    expect(text(alerts(view)[0]!)).toBe('Probe view stopped working.Try again');
    expect(view.counts.cleanups).toBe(1);
  }
  expect(reports).toHaveBeenCalledTimes(3);
});

it('line and block fallbacks show polite status, error detail and retry', () => {
  const error = new Error('First line\nMore detail');
  const line = open({ shows: 'line', error });
  line.set(1);
  expect(alerts(line)[0]!.props.role).toBe('status');
  expect(nodes(line.root).find((n) => n.tag === 'span' && n.props.title)?.props.title).toBe(error.message);
  expect(buttons(line)[0]!.props.class).toBe('cp-button');
  const block = open({ shows: 'block', error });
  block.set(1);
  expect(alerts(block)[0]!.props.role).toBe('status');
  expect(text(alerts(block)[0]!)).toBe('Probe view stopped working.First lineTry again');
  expect(nodes(block.root).find((n) => n.tag === 'p' && n.props.title)?.props.title).toBe(error.message);
  const empty = open({ shows: 'block', error: '' });
  empty.set(1);
  expect(nodes(empty.root).filter((n) => n.tag === 'p')).toHaveLength(1);
  const value = open({ shows: 'block', error: 'Plain failure' });
  value.set(1);
  expect(text(alerts(value)[0]!)).toContain('Plain failure');
});

it('panel failures keep the real section header and individual panel id', () => {
  const panel = open({ shows: { header: { section: 'plugin', panelId: 'plugin:probe:panel' } } });
  panel.set(1);
  const header = nodes(panel.root).find((n) => n.tag === 'header')!;
  expect(header.props['data-section']).toBe('plugin');
  expect(header.props['data-panel-color']).toBe('plugin:probe:panel');
  expect(text(header)).toContain('Probe view');
  expect(alerts(panel)[0]!.props.role).toBe('status');
  expect(text(alerts(panel)[0]!)).toBe('Probe view stopped working.Probe failureTry again');
});

it.each([{ section: 'chat' }, { section: 'plugin', panelId: 'plugin:probe:panel' }])('a failed panel folds and unfolds its body using %j', (header) => {
  const view = open({ shows: { header } });
  view.set(1);
  const toggle = (): TestNode => buttons(view).find((button) => 'aria-expanded' in button.props)!;
  expect(toggle().props['aria-expanded']).toBe(true);
  press(toggle());
  expect(toggle().props['aria-expanded']).toBe(false);
  expect(alerts(view)).toEqual([]);
  expect(nodes(view.root).some((node) => node.tag === 'header')).toBe(true);
  press(toggle());
  expect(toggle().props['aria-expanded']).toBe(true);
  expect(text(alerts(view)[0]!)).toBe('Probe view stopped working.Probe failureTry again');
});

it('a retry failure repeats the copy and restores focus only from inside the fallback', () => {
  const composer = { name: 'Composer' };
  const pageDocument: { activeElement: unknown } = { activeElement: composer };
  vi.stubGlobal('document', pageDocument);
  const view = open();
  view.set(1);
  expect(pageDocument.activeElement).toBe(composer);
  press(buttons(view)[0]!);
  expect(text(alerts(view)[0]!)).toBe("Probe view still isn't working.Try again");
  expect(pageDocument.activeElement).toBe(composer);
  const oldButton = buttons(view)[0]!;
  oldButton.focus();
  press(oldButton);
  expect(buttons(view)[0]).not.toBe(oldButton);
  expect(pageDocument.activeElement).toBe(buttons(view)[0]);
  view.healthy();
  press(buttons(view)[0]!);
  Object.defineProperty(pageDocument, 'activeElement', { configurable: true, value: composer });
  view.unhealthy();
  expect(pageDocument.activeElement).toBe(composer);
  const fresh = open();
  fresh.set(1);
  expect(text(alerts(fresh)[0]!)).toBe('Probe view stopped working.Try again');
});

it('focus in a failed panel header also belongs to the fallback', () => {
  const pageDocument: { activeElement: unknown } = { activeElement: null };
  vi.stubGlobal('document', pageDocument);
  const view = open({ shows: { header: { section: 'chat' } } });
  view.set(1);
  buttons(view).find((button) => button.props['aria-expanded'] !== undefined)!.focus();
  press(buttons(view).find((button) => text(button) === 'Try again')!);
  expect(pageDocument.activeElement).toBe(buttons(view).find((button) => text(button) === 'Try again'));
});

it('14: an inner boundary captures its failure; a throwing inner fallback reaches the outer boundary', () => {
  const inner = open({ nested: true });
  inner.set(1);
  expect(text(alerts(inner)[0]!)).toContain('Probe view stopped working.');
  expect(reports).toHaveBeenCalledTimes(1);
  reports.mockClear();
  const outer = open({ nested: true, throwFallback: true });
  outer.set(1);
  expect(text(alerts(outer)[0]!)).toBe('Outer view stopped working.Try again');
  expect(reports.mock.calls.map(([error]) => error)).toEqual([client.failure, client.fallbackFailure]);
});

it('15: contained mounts the body untracked and keeps getter, split, children and spread props reactive', () => {
  const view = client.mountProps();
  disposers.push(view.dispose);
  const p = (): TestNode => nodes(view.root).find((n) => n.tag === 'p')!;
  expect(text(p())).toBe('firstfirst');
  expect(p().props.title).toBe('Title first');
  expect(p().props['data-probe']).toBe('first');
  view.set('second');
  expect(view.reads).toEqual(['first']);
  expect(text(p())).toBe('secondsecond');
  expect(p().props.title).toBe('Title second');
  expect(p().props['data-probe']).toBe('second');
});

it('16: snapshot rejects initial and later failures and removes the stage even when disposal or setup throws', async () => {
  for (const kind of ['initial', 'later', 'dispose', 'layout']) {
    const snapshot = snapshots.makeSnapshot(kind);
    for (const [key, value] of Object.entries(snapshot.environment)) vi.stubGlobal(key, value);
    await expect(snapshot.run()).rejects.toBe(kind === 'dispose' ? snapshot.cleanupFailure : snapshot.failure);
    expect(snapshot.stages).toHaveLength(1);
    expect(snapshot.stages[0]!.live).toBe(false);
    expect(snapshot.counts.removed).toBe(1);
    expect(snapshot.counts.cleanups).toBe(kind === 'layout' ? 0 : 1);
    if (kind === 'initial') expect(snapshot.counts.frames).toBe(0);
    if (kind === 'later') expect(snapshot.counts.frames).toBeGreaterThan(0);
  }
  expect(reports).not.toHaveBeenCalled();
  const clean = snapshots.makeSnapshot('clean');
  for (const [key, value] of Object.entries(clean.environment)) vi.stubGlobal(key, value);
  await expect(clean.run()).resolves.toContain('<body><p>Probe</p></body>');
  expect(clean.counts.removed).toBe(1);
});

it.each(['memo', 'render', 'effect'])('%s failure blocks the same update and later seen marks until retry succeeds', async (kind) => {
  const view = seenClient.mountSeen(kind);
  disposers.push(view.dispose);
  await Promise.resolve();
  expect(view.marked).toEqual([0]);
  expect(view.shown).toEqual(['probe']);
  view.set(1);
  await Promise.resolve();
  expect(view.shows()).toBe(false);
  expect(view.marked).toEqual([0]);
  view.set(2);
  view.visible(false);
  view.visible(true);
  await Promise.resolve();
  expect(view.marked).toEqual([0]);
  expect(view.shown).toEqual(['probe']);
  view.healthy();
  press(buttons(view)[0]!);
  await Promise.resolve();
  expect(view.shows()).toBe(true);
  expect(view.shown).toEqual(['probe', 'probe']);
  expect(view.marked).toEqual([0, 2]);
  view.set(3);
  await Promise.resolve();
  expect(view.marked).toEqual([0, 2, 3]);
});

it('an inner failed boundary leaves the panel eligible', async () => {
  const view = seenClient.mountSeen('memo', true);
  disposers.push(view.dispose);
  await Promise.resolve();
  view.set(1);
  await Promise.resolve();
  expect(view.shows()).toBe(true);
  expect(view.marked).toEqual([0, 1]);
  view.set(2);
  await Promise.resolve();
  expect(view.marked).toEqual([0, 1, 2]);
  expect(view.shown).toEqual(['probe']);
});

it('without a view, marking stays tracked even while the view has failed', async () => {
  const view = seenClient.mountSeen('memo', false, false);
  disposers.push(view.dispose);
  await Promise.resolve();
  view.set(1);
  await Promise.resolve();
  view.set(2);
  await Promise.resolve();
  expect(view.marked).toEqual([0, 1, 2]);
  view.visible(false);
  view.set(3);
  await Promise.resolve();
  expect(view.marked).toEqual([0, 1, 2]);
  view.visible(true);
  await Promise.resolve();
  expect(view.marked).toEqual([0, 1, 2, 3]);
  expect(view.shown).toEqual(['probe', 'probe']);
});

it('a Plans-like source seeds after loading while its count stays zero', async () => {
  const view = seenClient.mountSeen('plans');
  disposers.push(view.dispose);
  await Promise.resolve();
  expect(view.marked).toEqual([]);
  expect(view.seeded()).toBeNull();
  view.loading(false);
  await Promise.resolve();
  expect(view.seeded()).toBe(0);
  expect(view.marked).toEqual([0]);
  await Promise.resolve();
  expect(view.marked).toEqual([0]);
});

it('onShown snapshots the prior watermark before any seen mark on eligibility changes', async () => {
  const view = seenClient.mountSeen('watermark');
  disposers.push(view.dispose);
  view.healthy();
  await Promise.resolve();
  expect(view.shownWatermarks).toEqual([null]);
  expect(view.seeded()).toBe(0);
  view.visible(false);
  view.set(5);
  await Promise.resolve();
  view.visible(true);
  await Promise.resolve();
  expect(view.shownWatermarks).toEqual([null, 0]);
  expect(view.seeded()).toBe(5);
});

it('a deferred onShown failure reaches its Contained owner and reports once', () => {
  const deferred: (() => void)[] = [];
  const schedule = queueMicrotask;
  vi.stubGlobal('queueMicrotask', (work: () => void) => deferred.push(work));
  try {
    const view = seenClient.mountSeen('throwing');
    disposers.push(view.dispose);
    const escaped: unknown[] = [];
    while (deferred.length) {
      try { deferred.shift()!(); } catch (error) { escaped.push(error); }
    }
    expect(escaped).toEqual([]);
    expect(text(alerts(view)[0]!)).toBe('Panel stopped working.Try again');
    expect(reports).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Shown failure' }));
    expect(view.marked).toEqual([]);
  } finally { vi.stubGlobal('queueMicrotask', schedule); }
});

it('a changed panel id marks after the flush and a disposed mount does not mark', async () => {
  const view = seenClient.mountSeen('memo');
  disposers.push(view.dispose);
  await Promise.resolve();
  view.id('other');
  expect(view.marked).toEqual([0]);
  await Promise.resolve();
  expect(view.marked.length).toBeGreaterThan(1);
  const marked = [...view.marked];
  view.set(1);
  view.dispose();
  disposers.pop();
  await Promise.resolve();
  expect(view.marked).toEqual(marked);
});
