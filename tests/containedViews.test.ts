import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildContainment } from './containmentBuild';
import { VIEWS_SOURCE, WRITES_STUB } from './containedViewsFixture';
import type { TestNode } from './sectionSplitHarness';
import { SNAPSHOT_ADAPTER, SNAPSHOT_SOURCE } from './containmentSnapshotFixture';
import { SEEN_STATE, SEEN_VIEWS_SOURCE } from './seenViewsFixture';

interface View {
  root: TestNode;
  dispose(): void;
  set(value: number): void;
  healthy(): void;
  seen: number[];
  counts: { mounts: number; cleanups: number; runs: number };
}
interface Client {
  failure: Error;
  fallbackFailure: Error;
  mount(options?: { shows?: string; children?: number; boundaries?: number; initial?: string; nested?: boolean; throwFallback?: boolean }): View;
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
const alerts = (v: { root: TestNode }): TestNode[] => nodes(v.root).filter((n) => n.props.role === 'alert');
const buttons = (v: { root: TestNode }): TestNode[] => nodes(v.root).filter((n) => n.tag === 'button');
const press = (button: TestNode): void => (button.props.onClick as () => void)();
const open = (options: Parameters<Client['mount']>[0] = {}): View => {
  const view = client.mount(options);
  disposers.push(view.dispose);
  return view;
};

beforeAll(async () => {
  client = await buildContainment<Client>(VIEWS_SOURCE, { './idbStore': WRITES_STUB });
  seenClient = await buildContainment(SEEN_VIEWS_SOURCE, {
    './idbStore': WRITES_STUB,
    'test:seen-state': SEEN_STATE,
    './looking': `export { createOnScreen, pageVisible, windowFocused } from 'test:seen-state';`,
    '@/state/layout': `export { isPanelCollapsed } from 'test:seen-state';`,
    '@/state/unread': `export { markPanelSeen, panelShown } from 'test:seen-state';`,
  });
  snapshots = await buildContainment(SNAPSHOT_SOURCE, {
    'solid-js/web': SNAPSHOT_ADAPTER,
    '@/theme/snapshot.css?raw': `export default 'Snapshot styles';`,
    './Snapshot.module.css': `export default { stage: 'probe-stage' };`,
  });
});
beforeEach(() => { reports.mockClear(); vi.stubGlobal('reportError', reports); });
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); });
afterAll(() => vi.unstubAllGlobals());

it('9: a failed note names the view, preserves sibling updates and retries with a fresh mount', () => {
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
  const page = open({ shows: 'reload' });
  page.set(1);
  expect(text(alerts(page)[0]!)).toBe('Probe view stopped working.Reload');
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
