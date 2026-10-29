// A cached-then-live answer (the Person window, reaction tips): the cached copy at once, the live answer over it, the
// cached copy kept when the live read fails, and never another target's answer.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface CachedLive<T> {
  value(): T | null;
  stale(): boolean;
  loading(): boolean;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const cachedLivePath = '../src/renderer/src/state/cachedLive';
const { cachedThenLive } = (await import(cachedLivePath)) as {
  cachedThenLive<S, T>(source: () => S | false | null | undefined, cached: (s: S) => Promise<T | null>, live: (s: S) => Promise<T>, wantLive?: (c: T | null, s: S) => boolean): CachedLive<T>;
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
type Pending = Map<string, { answer(v: string | null): void; fail(e: Error): void }>;
const read = (pending: Pending) => (s: string) => new Promise<string>((answer, fail) => pending.set(s, { answer: answer as (v: string | null) => void, fail }));

/** Cached and live reads of a target the test sets, each answered by the test. */
function harness(wantLive?: (c: string | null, s: string) => boolean) {
  const [target, setTarget] = createSignal<string | null>(null);
  const cached: Pending = new Map(), live: Pending = new Map();
  const r = createRoot(() => cachedThenLive<string, string>(target, read(cached), read(live), wantLive));
  return { r, setTarget, cached, live };
}

describe('a cached-then-live answer', () => {
  it('shows the cached copy, then the live answer over it', async () => {
    const h = harness();
    h.setTarget('A');
    expect(h.r.value()).toBeNull();
    expect(h.live.has('A')).toBe(false);
    h.cached.get('A')!.answer('cached A');
    await settle();
    expect(h.r.value()).toBe('cached A');
    expect(h.r.loading()).toBe(true);
    h.live.get('A')!.answer('live A');
    await settle();
    expect(h.r.value()).toBe('live A');
    expect(h.r.loading()).toBe(false);
    expect(h.r.stale()).toBe(false);
  });

  it("shows nothing of A's while B's copy loads, and A's late live answer never", async () => {
    const h = harness();
    h.setTarget('A');
    h.cached.get('A')!.answer('cached A');
    await settle();
    h.setTarget('B');
    expect(h.r.value()).toBeNull();
    h.live.get('A')!.answer('live A');
    await settle();
    expect(h.r.value()).toBeNull();
    h.cached.get('B')!.answer('cached B');
    await settle();
    expect(h.r.value()).toBe('cached B');
  });

  it('keeps the cached copy, marked stale, when the live read fails; a failed cache read is no copy', async () => {
    const h = harness();
    h.setTarget('A');
    h.cached.get('A')!.answer('cached A');
    await settle();
    h.live.get('A')!.fail(new Error('offline'));
    await settle();
    expect(h.r.value()).toBe('cached A');
    expect(h.r.stale()).toBe(true);
    h.setTarget('B');
    expect(h.r.stale()).toBe(false);
    h.cached.get('B')!.fail(new Error('no archive'));
    await settle();
    expect(h.r.value()).toBeNull();
    h.live.get('B')!.answer('live B');
    await settle();
    expect(h.r.value()).toBe('live B');
  });

  it('reads live only when wantLive asks, judged on the cached copy', async () => {
    const h = harness((copy) => copy === null);
    h.setTarget('A');
    h.cached.get('A')!.answer('cached A');
    await settle();
    expect(h.live.has('A')).toBe(false);
    expect(h.r.value()).toBe('cached A');
    expect(h.r.loading()).toBe(false);
    h.setTarget('B');
    h.cached.get('B')!.answer(null);
    await settle();
    expect(h.live.has('B')).toBe(true);
  });

  it('takes an object target, matched by identity (a reaction tip keys by message, emoji and count)', async () => {
    const [target, setTarget] = createSignal<{ id: string } | null>(null);
    const r = createRoot(() => cachedThenLive(target, async (t) => `cached ${t.id}`, async (t) => `live ${t.id}`));
    const a = { id: 'A' };
    setTarget(a);
    await settle();
    expect(r.value()).toBe('live A');
    setTarget({ id: 'A' });
    expect(r.value()).toBeNull();
    await settle();
    expect(r.value()).toBe('live A');
  });

  it('shows nothing once its target clears', async () => {
    const h = harness();
    h.setTarget('A');
    h.cached.get('A')!.answer('cached A');
    await settle();
    h.live.get('A')!.answer('live A');
    await settle();
    h.setTarget(null);
    expect(h.r.value()).toBeNull();
    expect(h.r.stale()).toBe(false);
  });
});
