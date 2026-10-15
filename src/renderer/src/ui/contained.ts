import { catchError, createComponent, createContext, createMemo, createSignal, untrack, useContext, type Accessor, type JSX, type Setter } from 'solid-js';
import { onCleanup, reportFailure } from '@plugin-sdk/renderer/containment';
import { whenWritten } from './idbStore';
import { ViewFailure } from './ViewFailure';

/** What a failed view leaves in its place. Reload is only for a page's root. */
export type FailureShown = 'note' | 'name' | 'nothing' | 'reload';
type ContainedProps = { name: string; shows: FailureShown; children: JSX.Element };

const ViewShownContext = createContext<Setter<boolean>>();

export interface ViewShown {
  /** False while the nearest boundary inside Watch shows its fallback. */
  readonly shows: Accessor<boolean>;
  readonly Watch: (props: { children: JSX.Element }) => JSX.Element;
}

export function createViewShown(): ViewShown {
  const [shows, setShows] = createSignal(true);
  return {
    shows,
    Watch: (props) => createComponent(ViewShownContext.Provider, { value: setShows, get children() { return props.children; } }),
  };
}

function fallback(props: ContainedProps, retry: () => void): JSX.Element {
  if (props.shows === 'nothing') return null;
  if (props.shows === 'name') return props.name;
  return createComponent(ViewFailure, {
    get name() { return props.name; },
    button: props.shows === 'reload' ? 'Reload' : 'Try again',
    onPress: props.shows === 'reload' ? () => void whenWritten().then(() => location.reload()) : retry,
  });
}

/** Reports and replaces failed children while the rest of the update completes. */
export function Contained(props: ContainedProps): JSX.Element {
  const setShows = useContext(ViewShownContext);
  setShows?.(true);
  onCleanup(() => setShows?.(true));
  const [failure, setFailure] = createSignal<{ error: unknown }>();
  const fail = (error: unknown): void => {
    setShows?.(false);
    reportFailure(error);
    setFailure({ error });
  };
  const retry = (): void => {
    setShows?.(true);
    setFailure(undefined);
  };
  return createMemo(() => failure() ? untrack(() => fallback(props, retry)) : catchError(() =>
    createComponent(ViewShownContext.Provider, { value: undefined, get children() { return props.children; } }), fail)) as unknown as JSX.Element;
}

/** Mounts the view untracked inside its own containment, passing the original props object. */
export const contained = <P extends object>(name: string, view: (props: P) => JSX.Element, shows: FailureShown): ((props: P) => JSX.Element) =>
  (props) => createComponent(Contained, { name, shows, get children() { return createComponent(view, props); } });
