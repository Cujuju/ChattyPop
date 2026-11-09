import { createSignal } from 'solid-js';
import { onCleanup } from '@plugin-sdk/renderer/containment';
import type { WindowControls, WindowFrameState } from '@shared/windowControls';

/** This window's maximized and full-screen state, kept current while the calling component lives. */
export function createWindowFrameState(controls: WindowControls): () => WindowFrameState {
  const [state, setState] = createSignal<WindowFrameState>({ maximized: false, fullScreen: false });
  onCleanup(controls.onStateChanged(setState));
  void controls.state().then(setState);
  return state;
}
