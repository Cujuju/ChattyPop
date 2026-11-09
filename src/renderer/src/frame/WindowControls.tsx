// Minimize, maximize/restore and close for a frameless window (Windows, Linux); macOS keeps its own traffic lights.
import type { JSX } from 'solid-js';
import type { WindowControls as Controls } from '@shared/windowControls';
import { createWindowFrameState } from './windowFrame';
import styles from './WindowControls.module.css';

// Windows' caption glyphs on a 10-unit grid, drawn with a 1-unit stroke.
const GLYPHS = {
  minimize: () => <path d="M0 5.5h10" />,
  maximize: () => <rect x="0.5" y="0.5" width="9" height="9" />,
  restore: () => <path d="M0.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2" />,
  close: () => <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
} satisfies Record<string, () => JSX.Element>;

function ControlButton(props: { label: string; glyph: keyof typeof GLYPHS; close?: boolean; onClick: () => void }) {
  return (
    <button type="button" class={styles.button} data-close={props.close} aria-label={props.label} title={props.label} onClick={() => props.onClick()}>
      <svg class={styles.glyph} viewBox="0 0 10 10" aria-hidden="true">
        {GLYPHS[props.glyph]()}
      </svg>
    </button>
  );
}

export function WindowControls(props: { controls: Controls }) {
  const state = createWindowFrameState(props.controls);
  const restores = (): boolean => state().maximized || state().fullScreen;
  return (
    <div class={styles.controls}>
      <ControlButton label="Minimize" glyph="minimize" onClick={() => props.controls.minimize()} />
      <ControlButton label={restores() ? 'Restore' : 'Maximize'} glyph={restores() ? 'restore' : 'maximize'} onClick={() => props.controls.toggleMaximize()} />
      <ControlButton label="Close" glyph="close" close onClick={() => props.controls.close()} />
    </div>
  );
}
