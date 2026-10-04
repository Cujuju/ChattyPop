// Resource reads that never throw: a failed fetch reads as no value plus its reason, and a later success clears it.
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { failure, settled } from '../src/plugin-sdk/renderer/settled';

const { createRoot, createResource, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

it('reads a resource whose fetch failed as undefined with its reason, and recovers on the next read', async () => {
  let fail = true;
  const [source, setSource] = createSignal(1);
  const r = createRoot(() => createResource(source, async (n) => {
    if (fail) throw new Error('provider read failed');
    return n;
  })[0]);
  await Promise.resolve();
  await Promise.resolve();
  expect(r.state).toBe('errored');
  expect(() => r()).toThrow('provider read failed'); // the bare read the panel made
  expect(settled(r)).toBeUndefined();
  expect(failure(r)).toBe('provider read failed');
  fail = false;
  setSource(2);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled(r)).toBe(2);
  expect(failure(r)).toBeNull();
});
