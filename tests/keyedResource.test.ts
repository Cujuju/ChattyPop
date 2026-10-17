// A resource keyed by its target (the Person and Conversation windows, the rule Who picker's search) shows only the
// current target's answer: never the previous target's while the next loads, nor any after the target clears.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface KeyedResource<T> {
  (): T | undefined;
  readonly loading: boolean;
  readonly failure: string | null;
  refetch(): void;
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
    h.r.refetch();
    expect(h.r()).toBe('first');
    h.pending.get('A')!.answer('second');
    await settle();
    expect(h.r()).toBe('second');
  });
});
