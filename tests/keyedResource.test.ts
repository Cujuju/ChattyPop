// A resource keyed by its target (the Person and Conversation windows, the rule Who picker's search) shows only the
// current target's answer: never the previous target's while the next loads, nor any after the target clears.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface KeyedResource<T> {
  (): T | undefined;
  readonly loading: boolean;
  readonly failure: string | null;
  refetch(): Promise<void>;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const keyedPath = '../src/renderer/src/state/keyedResource';
const { keyedResource } = (await import(keyedPath)) as {
  keyedResource<S, T>(source: () => S | false | null | undefined, fetch: (s: S) => Promise<T>): KeyedResource<T>;
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

/** A resource over a target the test sets, whose reads the test answers. */
function harness() {
  const [target, setTarget] = createSignal<string | null>(null);
  const pending = new Map<string, { answer(v: string): void; fail(e: Error): void }>();
  const r = createRoot(() =>
    keyedResource(target, (t) => new Promise<string>((answer, fail) => pending.set(t, { answer, fail }))),
  );
  return { r, setTarget, pending };
}

describe('a keyed resource', () => {
  it("shows nothing of A's while B loads, then B's", async () => {
    const h = harness();
    h.setTarget('A');
    h.pending.get('A')!.answer('profile of A');
    await settle();
    expect(h.r()).toBe('profile of A');
    h.setTarget('B');
    expect(h.r()).toBeUndefined();
    expect(h.r.loading).toBe(true);
    h.pending.get('B')!.answer('profile of B');
    await settle();
    expect(h.r()).toBe('profile of B');
  });

  it('shows nothing once its target clears, nor on reopening another (the picker cleared or closed)', async () => {
    const h = harness();
    h.setTarget('Alice');
    h.pending.get('Alice')!.answer('alice-id');
    await settle();
    h.setTarget(null);
    expect(h.r()).toBeUndefined();
    h.setTarget('Bob');
    expect(h.r()).toBeUndefined();
  });

  it("an older target's late answer never shows for the current one", async () => {
    const h = harness();
    h.setTarget('A');
    h.setTarget('B');
    h.pending.get('A')!.answer('profile of A');
    await settle();
    expect(h.r()).toBeUndefined();
  });

  it('a failed read reads as nothing with its reason, without throwing', async () => {
    const h = harness();
    h.setTarget('A');
    h.pending.get('A')!.fail(new Error('archive closed'));
    await settle();
    expect(h.r()).toBeUndefined();
    expect(h.r.failure).toBe('archive closed');
  });

  it('a refetch of the same target keeps its answer shown until the new one lands', async () => {
    const h = harness();
    h.setTarget('A');
    h.pending.get('A')!.answer('first');
    await settle();
    let finished = false;
    const refreshed = h.r.refetch().then(() => { finished = true; });
    expect(h.r()).toBe('first');
    await settle();
    expect(finished).toBe(false);
    h.pending.get('A')!.answer('second');
    await refreshed;
    expect(finished).toBe(true);
    expect(h.r()).toBe('second');
  });

  it('coalesces invalidations during the initial read into one awaitable reread', async () => {
    const h = harness();
    h.setTarget('A');
    const initial = h.pending.get('A')!;
    const first = h.r.refetch();
    const second = h.r.refetch();
    expect(first).toBe(second);
    expect(h.pending.get('A')).toBe(initial);
    initial.answer('initial');
    await settle();
    expect(h.pending.get('A')).not.toBe(initial);
    h.pending.get('A')!.answer('fresh');
    await first;
    expect(h.r()).toBe('fresh');
  });

  it('drops a queued reread after its source changes', async () => {
    const h = harness();
    h.setTarget('A');
    const queued = h.r.refetch();
    h.setTarget('B');
    h.pending.get('A')!.answer('old');
    await queued;
    h.pending.get('B')!.answer('current');
    await settle();
    expect(h.r()).toBe('current');
  });

  it('does not run an old queued reread after closing and reopening the same source', async () => {
    const h = harness();
    h.setTarget('A');
    const initial = h.pending.get('A')!;
    const queued = h.r.refetch();
    h.setTarget(null);
    h.setTarget('A');
    const reopened = h.pending.get('A')!;
    initial.answer('old');
    await queued;
    expect(h.pending.get('A')).toBe(reopened);
    reopened.answer('reopened');
    await settle();
    expect(h.r()).toBe('reopened');
  });

  it('runs its pending reread after a failed read and exposes the recovered answer', async () => {
    const h = harness();
    h.setTarget('A');
    const queued = h.r.refetch();
    h.pending.get('A')!.fail(new Error('connection lost'));
    await settle();
    h.pending.get('A')!.answer('recovered');
    await queued;
    expect(h.r()).toBe('recovered');
    expect(h.r.failure).toBeNull();
  });
});
