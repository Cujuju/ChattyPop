import { CONTAINMENT_ADAPTER } from './containmentBuild';

export const SNAPSHOT_ADAPTER = `export * from '${CONTAINMENT_ADAPTER}';`;
export const SNAPSHOT_SOURCE = `
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { snapshotPage } from '@/ui/snapshot';
import { node } from '${CONTAINMENT_ADAPTER}';
export function makeSnapshot(kind) {
  const failure = new Error('Snapshot failure'), cleanupFailure = new Error('Cleanup failure');
  const [value, setValue] = createSignal(0);
  const stages = [], counts = { cleanups: 0, frames: 0, removed: 0 };
  const environment = {
    document: {
      createElement: () => {
        const stage = Object.assign(node('stage'), {
          style: {}, innerHTML: '<p>Probe</p>', live: false,
          setAttribute() {}, remove() { this.live = false; counts.removed++; },
        });
        stages.push(stage);
        return stage;
      },
      body: { append: stage => { stage.live = true; } },
      fonts: { ready: Promise.resolve() }, documentElement: { attributes: [] },
      styleSheets: [{ href: 'https://example.com/styles.css', cssRules: [{ cssText: 'p {}' }] }],
    },
    getComputedStyle: () => {
      if (kind === 'layout') throw failure;
      return { getPropertyValue: () => '0' };
    },
    CSSFontFaceRule: class {},
    requestAnimationFrame: done => queueMicrotask(() => {
      counts.frames++;
      if (kind === 'later') setValue(1);
      done();
    }),
  };
  const view = () => {
    onCleanup(() => { counts.cleanups++; if (kind === 'dispose') throw cleanupFailure; });
    if (kind === 'initial') throw failure;
    createEffect(() => { if (value()) throw failure; });
    return <p>Probe</p>;
  };
  return { environment, stages, counts, failure, cleanupFailure,
    run: () => snapshotPage(view, { title: 'Probe', width: 400 }),
  };
}
`;
