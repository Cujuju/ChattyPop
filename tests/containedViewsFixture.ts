import { CONTAINMENT_ADAPTER } from './containmentBuild';

export const WRITES_STUB = `
let waiting = Promise.resolve(), finish;
export function holdWrite() { waiting = new Promise(done => finish = done); }
export function finishWrite() { finish(); }
export function whenWritten() { return waiting; }
`;

export const HEADER_STUBS = {
  '@/layout/panelMenu': `export const movable = () => true, panelDragProps = () => ({}), panelMenu = () => [];`,
  '@/state/layout': `
    import { createSignal } from 'solid-js';
    const [collapsed, setCollapsed] = createSignal(new Set());
    export const isPanelCollapsed = id => collapsed().has(id), isPlaced = () => true;
    export const setPanelCollapsed = (id, value) => setCollapsed(before => {
      const next = new Set(before);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  `,
  '@/state/ui': `export const outsideLayout = false, openContextMenu = () => {};`,
  '@shared/bundledPlugins': `export const bundledPanel = () => undefined;`,
};

export const VIEWS_SOURCE = `
import { createComponent, createEffect, createMemo, createSignal, onCleanup, splitProps } from 'solid-js';
import { Contained, contained } from '@/ui/contained';
import { node, render } from '${CONTAINMENT_ADAPTER}';
export { holdWrite, finishWrite } from './idbStore';
export const failure = new Error('Probe failure'), fallbackFailure = new Error('Fallback failure');

export function mount(opts = {}) {
  const [value, setValue] = createSignal(0), [failing, setFailing] = createSignal(true);
  const seen = [], counts = { mounts: 0, cleanups: 0, runs: 0 };
  const Body = () => {
    counts.mounts++;
    onCleanup(() => counts.cleanups++);
    if (opts.initial === 'direct') throw opts.error ?? failure;
    if (opts.initial === 'memo') createMemo(() => { throw opts.error ?? failure; });
    if (opts.initial === 'effect') createEffect(() => { throw opts.error ?? failure; });
    createEffect(() => {
      counts.runs++;
      if (value() > 0 && failing()) throw opts.error ?? failure;
    });
    return <span>Ready {value()}</span>;
  };
  const region = () => createComponent(Contained, {
    get name() { if (opts.throwFallback) throw fallbackFailure; return 'Probe view'; },
    shows: opts.shows ?? 'line',
    get children() { return Array.from({ length: opts.children ?? 1 }, () => <Body />); },
  });
  const Regions = () => Array.from({ length: opts.boundaries ?? 1 }, region);
  const root = node('root');
  const dispose = render(() => {
    createEffect(() => { seen.push(value()); });
    return <>
      {opts.nested ? <Contained name="Outer view" shows="line"><Regions /></Contained> : <Regions />}
      <span data-sibling>{value()}</span>
    </>;
  }, root);
  return { root, dispose, set: setValue, healthy: () => setFailing(false), unhealthy: () => setFailing(true), seen, counts };
}

export function mountProps() {
  const [value, setValue] = createSignal('first');
  const reads = [];
  const Body = props => {
    reads.push(value());
    const [own, rest] = splitProps(props, ['value', 'children']);
    return <p {...rest}><span>{own.value}</span>{own.children}</p>;
  };
  const Wrapped = contained('Props view', Body, 'line');
  const props = {
    get value() { return value(); },
    get children() { return <b>{value()}</b>; },
    get title() { return 'Title ' + value(); },
    get 'data-probe'() { return value(); },
  };
  const root = node('root');
  const dispose = render(() => createComponent(Wrapped, props), root);
  return { root, dispose, set: setValue, reads };
}
`;
