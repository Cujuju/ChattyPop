import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildContainment } from './containmentBuild';

type Client = typeof import('solid-js') & typeof import('solid-js/store') & {
  containedRoot<T>(make: () => T): T;
  ownedOrContained<T>(make: () => T): T;
  batchWrites<T>(write: () => T): T;
  reportFailure(error: unknown): void;
};
let s: Client;
const reports = vi.fn();
const disposers: (() => void)[] = [];
const failure = new Error('Probe failure');
const setupKinds = ['direct', 'memo', 'renderEffect', 'effect'] as const;

beforeAll(async () => {
  s = await buildContainment<Client>(`
    export * from 'solid-js';
    export * from 'solid-js/store';
    export * from '@plugin-sdk/renderer/containment';
  `);
});
beforeEach(() => { reports.mockClear(); vi.stubGlobal('reportError', reports); });
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); vi.unstubAllGlobals(); });

it('1: an uncontained memo aborts a store update and leaves its sibling stale on two more writes', () => {
  const [turn, setTurn] = s.createSignal(0);
  const [store, setStore] = s.createStore({ value: 0 });
  const seen: number[] = [];
  s.createRoot((dispose) => {
    disposers.push(dispose);
    s.createMemo(() => { if (turn()) throw failure; return 0; });
    s.createEffect(() => { seen.push(store.value); });
  });
  expect(() => s.batch(() => { setTurn(1); setStore('value', 1); })).toThrow(failure);
  setStore('value', 2);
  setStore('value', 3);
  expect(seen).toEqual([0]);
});

const throwDuringSetup = (kind: typeof setupKinds[number]): void => {
  if (kind === 'direct') throw failure;
  const thrower = (): never => { throw failure; };
  if (kind === 'memo') s.createMemo(thrower);
  if (kind === 'renderEffect') s.createRenderEffect(thrower);
  if (kind === 'effect') s.createEffect(thrower);
};

it('2: top-level setup failures raise after cleanup; clean setup returns its value', () => {
  for (const kind of setupKinds) {
    const cleaned = vi.fn();
    expect(() => s.containedRoot(() => {
      s.onCleanup(cleaned);
      throwDuringSetup(kind);
    })).toThrow(failure);
    expect(cleaned).toHaveBeenCalledTimes(1);
  }
  expect(s.containedRoot(() => 'ready')).toBe('ready');
  expect(reports).not.toHaveBeenCalled();
});

it('3: active-update direct setup failure raises and disposes; first-run computations report and return', () => {
  const cleaned = vi.fn();
  s.batch(() => {
    expect(() => s.containedRoot(() => { s.onCleanup(cleaned); throw failure; })).toThrow(failure);
    for (const kind of setupKinds.filter((kind) => kind !== 'direct')) {
      expect(s.containedRoot(() => { throwDuringSetup(kind); return 'ready'; })).toBe('ready');
    }
    expect(reports).not.toHaveBeenCalled();
  });
  expect(cleaned).toHaveBeenCalledTimes(1);
  expect(reports.mock.calls.map(([error]) => error)).toEqual([failure, failure, failure]);
});

it('4: a failed setup leaves none of its effects running on a later write', () => {
  const [value, setValue] = s.createSignal(0);
  const runs = vi.fn();
  expect(() => s.containedRoot(() => {
    s.createRenderEffect(() => { value(); runs(); });
    s.createEffect(() => { value(); runs(); });
    s.createMemo(() => { throw failure; });
  })).toThrow(failure);
  const before = runs.mock.calls.length;
  setValue(1);
  expect(runs).toHaveBeenCalledTimes(before);
});

it('5: later failures preserve siblings and memo values, deduplicate per root and recover on read', () => {
  const [value, setValue] = s.createSignal(0);
  const seen: number[] = [];
  s.containedRoot(() => s.createEffect(() => { if (value() === 1) throw failure; }));
  s.containedRoot(() => s.createEffect(() => { seen.push(value()); }));
  const memo = s.containedRoot(() => s.createMemo(() => {
    if (value() === 1) throw failure;
    return value();
  }));
  setValue(1);
  expect(seen).toEqual([0, 1]);
  expect(memo()).toBe(0);
  expect(memo()).toBe(0);
  expect(reports).toHaveBeenCalledTimes(2);
  setValue(2);
  expect(memo()).toBe(2);
  expect(seen).toEqual([0, 1, 2]);
});

it('6: a throwing resource source is contained and recovers on refetch; fetch failures remain resource state', async () => {
  const [key, setKey] = s.createSignal(0);
  const loads: number[] = [];
  const [resource, actions] = s.containedRoot(() => s.createResource(() => {
    if (key() === 1) throw failure;
    return key();
  }, (key) => { loads.push(key); return key; }));
  expect(resource()).toBe(0);
  setKey(1);
  setKey(2);
  expect(resource()).toBe(0);
  expect(loads).toEqual([0]);
  expect(reports).toHaveBeenCalledWith(failure);
  actions.refetch();
  expect(resource()).toBe(2);
  expect(loads.slice(1)).not.toHaveLength(0);
  expect(loads.slice(1).every((key) => key === 2)).toBe(true);
  const [rejected] = s.containedRoot(() => s.createResource(() => Promise.reject(failure)));
  await Promise.resolve();
  expect(rejected.state).toBe('errored');
  expect(rejected.error).toBe(failure);
  expect(reports).toHaveBeenCalledTimes(1);
});

it('7: ownedOrContained retains a contained owner and its disposal; ownerless calls are contained', () => {
  const cleaned = vi.fn();
  const [value, setValue] = s.createSignal(0);
  const seen: number[] = [];
  let dispose!: () => void;
  s.createRoot((d) => {
    dispose = d;
    s.catchError(() => {
      const owner = s.getOwner();
      s.ownedOrContained(() => {
        expect(s.getOwner()).toBe(owner);
        s.onCleanup(cleaned);
        s.createEffect(() => { seen.push(value()); });
      });
    }, reports);
  });
  dispose();
  setValue(1);
  expect(cleaned).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([0]);
  expect(s.getOwner()).toBeNull();
  s.ownedOrContained(() => {
    expect(s.getOwner()).not.toBeNull();
    s.createEffect(() => { if (value() === 2) throw failure; });
  });
  setValue(2);
  expect(reports).toHaveBeenCalledWith(failure);
});

it('8: batchWrites flushes top-level, nested and store-updater writes before raising and returns values', () => {
  const [store, setStore] = s.createStore({ value: 0 });
  const seen: number[] = [];
  s.containedRoot(() => s.createEffect(() => { seen.push(store.value); }));
  expect(() => s.batchWrites(() => { setStore('value', 1); throw failure; })).toThrow(failure);
  expect(seen).toEqual([0, 1]);
  expect(() => s.batchWrites(() => s.batchWrites(() => { setStore('value', 2); throw failure; }))).toThrow(failure);
  expect(seen).toEqual([0, 1, 2]);
  expect(() => s.batchWrites(() => setStore('value', () => {
    setStore('value', 3);
    throw failure;
  }))).toThrow(failure);
  expect(seen).toEqual([0, 1, 2, 3]);
  expect(s.batchWrites(() => 'ready')).toBe('ready');
  expect(s.batchWrites(() => undefined)).toBeUndefined();
  s.containedRoot(() => s.createEffect(() => {
    if (store.value === 4) s.batchWrites(() => { setStore('value', 5); throw failure; });
  }));
  setStore('value', 4);
  expect(seen.at(-1)).toBe(5);
  expect(reports).toHaveBeenCalledWith(failure);
});

it('reportFailure contains throwing reporters and does not track their reactive reads', () => {
  const [value, setValue] = s.createSignal(0);
  const runs = vi.fn();
  vi.stubGlobal('reportError', () => { value(); throw failure; });
  s.containedRoot(() => s.createEffect(() => { runs(); s.reportFailure(failure); }));
  setValue(1);
  expect(runs).toHaveBeenCalledTimes(1);
});
