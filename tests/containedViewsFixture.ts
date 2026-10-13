import { CONTAINMENT_ADAPTER } from './containmentBuild';

export const WRITES_STUB = `
let waiting = Promise.resolve(), finish;
export function holdWrite() { waiting = new Promise(done => finish = done); }
export function finishWrite() { finish(); }
export function whenWritten() { return waiting; }
`;

export const VIEWS_SOURCE = `
import { createComponent, createEffect, createMemo, createSignal, onCleanup, splitProps } from 'solid-js';
import { Contained, contained } from '@/ui/contained';
import { node, render } from '${CONTAINMENT_ADAPTER}';
export { holdWrite, finishWrite } from '@/ui/idbStore';
export const failure = new Error('Probe failure'), fallbackFailure = new Error('Fallback failure');

export function mount(opts = {}) {
  const [value, setValue] = createSignal(0), [failing, setFailing] = createSignal(true);
  const seen = [], counts = { mounts: 0, cleanups: 0, runs: 0 };
  const Body = () => {
    counts.mounts++;
    onCleanup(() => counts.cleanups++);
    if (opts.initial === 'direct') throw failure;
    if (opts.initial === 'memo') createMemo(() => { throw failure; });
    if (opts.initial === 'effect') createEffect(() => { throw failure; });
    createEffect(() => {
      counts.runs++;
      if (value() > 0 && failing()) throw failure;
    });
    return <span>Ready {value()}</span>;
  };
  const region = () => createComponent(Contained, {
    get name() { if (opts.throwFallback) throw fallbackFailure; return 'Probe view'; },
    shows: opts.shows ?? 'note',
    get children() { return Array.from({ length: opts.children ?? 1 }, () => <Body />); },
  });
  const Regions = () => Array.from({ length: opts.boundaries ?? 1 }, region);
  const root = node('root');
  const dispose = render(() => {
    createEffect(() => { seen.push(value()); });
    return <>
      {opts.nested ? <Contained name="Outer view" shows="note"><Regions /></Contained> : <Regions />}
      <span data-sibling>{value()}</span>
    </>;
  }, root);
  return { root, dispose, set: setValue, healthy: () => setFailing(false), seen, counts };
}

export function mountProps() {
  const [value, setValue] = createSignal('first');
  const reads = [];
  const Body = props => {
    reads.push(value());
    const [own, rest] = splitProps(props, ['value', 'children']);
    return <p {...rest}><span>{own.value}</span>{own.children}</p>;
  };
  const Wrapped = contained('Props view', Body, 'note');
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
